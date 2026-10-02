import type { LocalProvider, Provider } from '../constants.js';
import type { Video } from '../types.js';

export interface MediaSource {
	url: string;
	kind: 'hls' | 'mp4';
	quality?: string;
}

export interface VideoPage {
	videos: Video[];
	nextPage?: string;
}

interface BaseProvider {
	readonly id: Provider;
	readonly estimatedBytesPerSecond: number;
	videoUrl(video: Video): string;
	resolvePlayback(video: Video, signal?: AbortSignal): Promise<MediaSource>;
}

export interface LocalVideoProvider extends BaseProvider {
	readonly id: LocalProvider;
	readonly kind: 'local';
	fetchVideos(after?: string, signal?: AbortSignal): Promise<Video[]>;
	save(video: Video): Promise<void>;
	edit(video: Video, segments: string[]): Promise<void>;
	returnOriginal(video: Video): Promise<void>;
}

export interface OnlineVideoProvider extends BaseProvider {
	readonly kind: 'online';
	readonly homeUrl: string;
	readonly loginUrl: string;
	matchRoute(path: string): 'list' | 'video' | 'login' | null;
	fetchPage(cursor?: string, signal?: AbortSignal): Promise<VideoPage>;
	waitForLogin(): Promise<void>;
	readonly live?: LiveActions;
}

// Live streams: the streamer actions and list rules of Tango (formerly Stream Viewer).
// Videos are streamers (filename = streamer ID) and their current streams.
export interface LiveActions {
	// The PC download list that the +/- button edits, by streamer ID.
	readonly downloadList: LocalProvider;
	// Session and playback-token upkeep for the document; runs before anything loads.
	start(): Promise<void>;
	follow(video: Video, follow: boolean): Promise<void>;
	block(video: Video): Promise<void>;
	// Co-streamers of a stream; the viewer appends new ones to the bottom of the list.
	related(video: Video): Promise<Video[]>;
}

export type VideoProvider = LocalVideoProvider | OnlineVideoProvider;

export class AuthenticationRequiredError extends Error {}
export class ApiError extends Error {
	constructor(readonly status: number, message: string) { super(message); }
}
