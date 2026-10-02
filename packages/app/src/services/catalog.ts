import type { Provider } from '../constants.js';
import type { Video } from '../types.js';
import { AuthenticationRequiredError, getProvider } from '../providers/index.js';

interface SavedCatalog { videos: Video[]; nextPage?: string }

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

	constructor(id: Provider, private readonly changed: (videos: Video[]) => void) {
		this.source = getProvider(id);
		this.key = `video-catalog:${id}`;
	}

	async open(reuse: boolean): Promise<void> {
		this.stop();
		const controller = new AbortController();
		this.controller = controller;
		const saved = this.source.kind === 'online' && reuse ? this.read() : null;
		this.state = saved ?? (this.source.kind === 'online'
			? await this.source.fetchPage(undefined, controller.signal)
			: { videos: await this.source.fetchVideos(undefined, controller.signal) });
		if (controller.signal.aborted) return;
		this.publish();
	}

	resume(): void {
		if (this.source.kind !== 'online' || document.hidden) return;
		this.stop();
		this.state = this.read() ?? this.state;
		this.changed(this.state.videos);
		const generation = this.generation;
		const controller = new AbortController();
		this.controller = controller;
		const source = this.source;
		void (async () => {
			let delay = 1000;
			while (this.state.nextPage && generation === this.generation) {
				try {
					const page = await source.fetchPage(this.state.nextPage, controller.signal);
					if (generation !== this.generation) return;
					const seen = new Set(this.state.videos.map(video => video.filename));
					this.state = { videos: [...this.state.videos, ...page.videos.filter(video => {
						if (seen.has(video.filename)) return false;
						seen.add(video.filename); return true;
					})], nextPage: page.nextPage };
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

	private publish(): void {
		if (this.source.kind === 'online') sessionStorage.setItem(this.key, JSON.stringify(this.state));
		this.changed(this.state.videos);
	}

	private read(): SavedCatalog | null {
		const raw = sessionStorage.getItem(this.key);
		return raw ? JSON.parse(raw) as SavedCatalog : null;
	}
}

export function cachedVideo(id: Provider, path: string): Video | undefined {
    const raw = sessionStorage.getItem(`video-catalog:${id}`);
    return raw ? (JSON.parse(raw) as SavedCatalog).videos.find(video => video.pageUrl === path) : undefined;
}
