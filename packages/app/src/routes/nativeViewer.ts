import { PROVIDERS, STORAGE_KEYS, VIDEO_TYPE, type LocalProvider, type Provider } from '../constants.js';
import { AuthenticationRequiredError, getProvider, videoUrl } from '../providers/index.js';
import { cachedVideo } from '../services/catalog.js';
import { extractIdentifier } from '../services/downloadList.js';
import type { Video, VideoType } from '../types.js';

// The iPhone apps play videos in a native viewer (apps/ios VideoApp/Viewer*.swift): WebKit pauses
// a page's video when the phone locks or the app leaves the screen, a native player does not.
// The list stays on this page. A row opens the native viewer with the list; the list's later
// changes follow it, and it asks this page for what only the provider can do (playback sources,
// co-streamers, follow, block, the login page). Safari has no such handler and keeps the web viewer.

// What the native viewer needs to know about a video without asking: its provider's kind, a
// playback source when one is known (local HLS, Tango's playlists), and its download-list streamer.
export interface NativeVideo extends Video {
	readonly local: boolean;
	readonly live: boolean;
	readonly media?: { url: string; kind: 'hls' | 'mp4' };
	readonly membership?: { lists: LocalProvider[]; identifier: string; choose: boolean };
}

// A viewer address opened in the app (a restored page or a link): the list opens with it.
export type Requested = { filename: string; type: VideoType | null } | { path: string };

// The list page's side: its catalog's live changes and its highlighted row.
export interface NativeHost {
	readonly provider: Provider;
	remove(filename: string): void;
	append(videos: Video[]): void;
	update(video: Video): void;
	highlight(filename: string, reveal: boolean): void;
}

export function hasNativeViewer(): boolean {
	return window.webkit?.messageHandlers?.videoViewer !== undefined;
}

function post(message: unknown): void {
	void window.webkit?.messageHandlers?.videoViewer?.postMessage(message).catch((error: unknown) => {
		console.warn('Native viewer message failed', error);
	});
}

function absolute(url: string): string {
	return new URL(url, location.href).href;
}

export function describe(video: Video): NativeVideo {
	const source = getProvider(video.provider);
	const hint = source.mediaHint?.(video);
	let lists: LocalProvider[] = [];
	let identifier: string | undefined;
	let choose = false;
	if (source.kind === 'local') {
		lists = [source.id];
		identifier = extractIdentifier(video.filename);
	} else if (source.live) {
		lists = [source.live.downloadList];
		identifier = video.filename;
	} else {
		// Video Vault's uploads: whichever list has the recording's streamer (downloadList.ts).
		identifier = source.uploadStreamer?.(video);
		lists = [...PROVIDERS];
		choose = true;
	}
	return {
		...video,
		local: source.kind === 'local',
		live: source.kind === 'online' && source.live !== undefined,
		media: hint ? { url: absolute(hint.url), kind: hint.kind } : undefined,
		membership: identifier ? { lists, identifier, choose } : undefined
	};
}

// The provider's own fields, without what describe() added.
function plain(value: Video): Video {
	const { local: _local, live: _live, media: _media, membership: _membership, ...video } = value as NativeVideo;
	return video;
}

export class NativeViewer {
	private ready = false;

	constructor(private readonly host: NativeHost) {
		const methods: Record<string, (...args: never[]) => unknown> = {
			resolve: async (video: Video) => {
				const source = await getProvider(video.provider).resolvePlayback(plain(video));
				return { url: absolute(source.url), kind: source.kind };
			},
			related: async (video: Video) => {
				const source = getProvider(video.provider);
				if (source.kind !== 'online' || !source.live) return [];
				return (await source.live.related(plain(video))).map(describe);
			},
			follow: async (video: Video, follow: boolean) => {
				const source = getProvider(video.provider);
				if (source.kind !== 'online' || !source.live) throw new Error('This provider cannot follow.');
				await source.live.follow(plain(video), follow);
				host.update({ ...plain(video), following: follow });
			},
			block: async (video: Video) => {
				const source = getProvider(video.provider);
				if (source.kind !== 'online' || !source.live) throw new Error('This provider cannot block.');
				await source.live.block(plain(video));
			},
			remove: (filename: string) => host.remove(filename),
			append: (videos: Video[]) => host.append(videos.map(plain)),
			highlight: (filename: string, reveal: boolean) => host.highlight(filename, reveal),
			login: () => {
				const source = getProvider(host.provider);
				if (source.kind === 'online') location.assign(source.loginUrl);
			}
		};
		window.__videoApp = {
			async call(name, args) {
				const method = methods[name];
				if (!method) return { error: `Unknown request: ${name}` };
				try {
					return { ok: (await (method as (...values: unknown[]) => unknown)(...args)) ?? null };
				} catch (error) {
					return {
						error: error instanceof Error ? error.message : String(error),
						auth: error instanceof AuthenticationRequiredError
					};
				}
			}
		};
	}

	// The list as it stands; the first one also tells the app this page can answer.
	list(videos: Video[]): void {
		post({ type: 'list', provider: this.host.provider, videos: videos.map(describe) });
		if (!this.ready) {
			this.ready = true;
			post({ type: 'ready', provider: this.host.provider, origin: location.origin, userAgent: navigator.userAgent });
		}
	}

	open(videos: Video[], video: Video): void {
		let index = videos.findIndex(item => item.filename === video.filename && item.type === video.type);
		if (index < 0) {
			videos = [video, ...videos];
			index = 0;
		}
		const progress: Record<string, number> = {};
		for (const item of videos) {
			const saved = Number.parseFloat(localStorage.getItem(STORAGE_KEYS.PROGRESS_PREFIX + item.filename) ?? '');
			if (Number.isFinite(saved) && saved > 0) progress[item.filename] = saved;
		}
		post({ type: 'open', provider: this.host.provider, videos: videos.map(describe), index, progress });
	}

	// The video a viewer address names, from the list, the saved catalogs or the address itself.
	requested(videos: Video[], requested: Requested): Video {
		if ('path' in requested) {
			return videos.find(video => videoUrl(video) === requested.path)
				?? cachedVideo(this.host.provider, requested.path)
				?? routeVideo(this.host.provider, requested.path);
		}
		return videos.find(video => video.filename === requested.filename && (requested.type === null || video.type === requested.type))
			?? { filename: requested.filename, type: requested.type ?? VIDEO_TYPE.ORIGINAL, duration: 0, size: 0, isLive: false, provider: this.host.provider };
	}
}

function routeVideo(provider: Provider, path: string): Video {
	const source = getProvider(provider);
	const routed = source.kind === 'online' ? source.routeVideo?.(path) : undefined;
	return routed ?? { pageUrl: path, filename: path, type: VIDEO_TYPE.ORIGINAL, duration: 0, size: 0, isLive: false, provider };
}
