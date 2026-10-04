import type { Provider } from '../constants.js';
import type { Video } from '../types.js';
import { AuthenticationRequiredError, getProvider, videoUrl } from '../providers/index.js';
import type { Notice, VideoPage } from '../providers/types.js';

interface SavedCatalog {
	videos: Video[];
	nextPage?: string;
	notices?: Notice[];
	// Ordered lists (Video Vault) reload in the background from their last complete list:
	// the uploads read so far, and whether the first page is still to come.
	fresh?: Video[];
	restart?: boolean;
}

// An online cursor follows the list into its video document. Hidden documents
// cancel work so they cannot overwrite a newer document's completed pages.
export class VideoCatalog {
	private readonly source;
	private readonly key;
	private state: SavedCatalog = { videos: [] };
	private controller: AbortController | null = null;
	private generation = 0;
	private retryTimer: number | undefined;
	private finishWait: (() => void) | undefined;

	constructor(id: Provider, private readonly changed: (videos: Video[], notices: readonly Notice[]) => void) {
		this.source = getProvider(id);
		this.key = `video-catalog:${id}`;
	}

	async open(reuse: boolean): Promise<void> {
		this.stop();
		const controller = new AbortController();
		this.controller = controller;
		const saved = this.source.kind === 'online' && reuse ? this.read() : null;
		if (saved) this.state = saved;
		else if (this.source.kind === 'local') this.state = { videos: await this.source.fetchVideos(undefined, controller.signal) };
		else if (this.source.order) {
			// Open with the last complete list; the reload replaces it when it finishes.
			const complete = this.readComplete();
			this.state = complete ? { ...complete, fresh: [], restart: true } : { videos: [], fresh: [] };
			if (!complete) this.absorb(await this.source.fetchPage(undefined, controller.signal));
		} else this.state = await this.source.fetchPage(undefined, controller.signal);
		if (controller.signal.aborted) return;
		this.publish();
	}

	resume(): void {
		if (this.source.kind !== 'online' || document.hidden) return;
		this.stop();
		this.state = this.read() ?? this.state;
		this.changed(this.state.videos, this.state.notices ?? []);
		const generation = this.generation;
		const controller = new AbortController();
		this.controller = controller;
		const source = this.source;
		void (async () => {
			let delay = 1000;
			while ((this.state.restart || this.state.nextPage) && generation === this.generation) {
				try {
					const page = await source.fetchPage(this.state.restart ? undefined : this.state.nextPage, controller.signal);
					if (generation !== this.generation) return;
					this.absorb(page);
					this.publish();
					delay = 1000;
				} catch (error) {
					if (generation !== this.generation) return;
					if (error instanceof AuthenticationRequiredError) { location.assign(source.loginUrl); return; }
					console.error('Video pagination failed', error);
					await new Promise<void>(resolve => {
						this.finishWait = resolve;
						this.retryTimer = window.setTimeout(resolve, delay);
					});
					delay = Math.min(delay * 2, 30_000);
				}
			}
		})();
	}

	stop(): void {
		this.generation++;
		this.controller?.abort();
		this.controller = null;
		clearTimeout(this.retryTimer);
		this.finishWait?.();
		this.finishWait = undefined;
	}

	// Live lists change while open: co-streamers join at the bottom, ended or blocked streams
	// leave, and follow state updates. Existing entries keep their order.
	append(videos: Video[]): void {
		const seen = new Set(this.state.videos.map(video => video.filename));
		const added = videos.filter(video => !seen.has(video.filename) && seen.add(video.filename));
		if (!added.length) return;
		this.state = { ...this.state, videos: [...this.state.videos, ...added] };
		this.publish();
	}

	remove(filename: string): void {
		this.state = { ...this.state, videos: this.state.videos.filter(video => video.filename !== filename) };
		this.publish();
	}

	update(video: Video): void {
		this.state = { ...this.state, videos: this.state.videos.map(item => item.filename === video.filename ? video : item) };
		this.publish();
	}

	// Site order appends each page. An ordered list shows its earlier rows with the uploads read
	// so far until the reload finishes; then only what was listed remains, except the rows of a
	// site that could not be listed.
	private absorb(page: VideoPage): void {
		const order = this.source.kind === 'online' ? this.source.order : undefined;
		if (!order) {
			this.state = { videos: unique([...this.state.videos, ...page.videos]), nextPage: page.nextPage };
			return;
		}
		const fresh = unique([...(this.state.fresh ?? []), ...page.videos]);
		const done = page.nextPage === undefined;
		const earlier = done ? this.state.videos.filter(video => page.incomplete?.includes(video.provider)) : this.state.videos;
		this.state = { videos: order(unique([...fresh, ...earlier])), nextPage: page.nextPage, notices: page.notices,
			...(done ? {} : { fresh }) };
		if (done) localStorage.setItem(`${this.key}:complete`, JSON.stringify({ videos: this.state.videos, notices: page.notices ?? [] }));
	}

	private publish(): void {
		if (this.source.kind === 'online') sessionStorage.setItem(this.key, JSON.stringify(this.state));
		this.changed(this.state.videos, this.state.notices ?? []);
	}

	private read(): SavedCatalog | null {
		const raw = sessionStorage.getItem(this.key);
		return raw ? JSON.parse(raw) as SavedCatalog : null;
	}

	private readComplete(): SavedCatalog | null {
		const raw = localStorage.getItem(`${this.key}:complete`);
		return raw ? JSON.parse(raw) as SavedCatalog : null;
	}
}

// The first of each filename wins: a page's fresh entry over an earlier row.
function unique(videos: Video[]): Video[] {
	const seen = new Set<string>();
	return videos.filter(video => !seen.has(video.filename) && !!seen.add(video.filename));
}

export function cachedVideo(id: Provider, path: string): Video | undefined {
    const key = `video-catalog:${id}`;
    for (const raw of [sessionStorage.getItem(key), localStorage.getItem(`${key}:complete`)]) {
        const video = raw ? (JSON.parse(raw) as SavedCatalog).videos.find(video => videoUrl(video) === path) : undefined;
        if (video) return video;
    }
    return undefined;
}
