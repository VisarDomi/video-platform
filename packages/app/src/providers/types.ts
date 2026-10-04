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
	// Video Vault: sites that need attention (such as a login), and sites whose uploads could
	// not be listed, so their earlier rows stay.
	notices?: Notice[];
	incomplete?: Provider[];
}

// A message above the list, linking to where it can be fixed.
export interface Notice {
	readonly text: string;
	readonly href?: string;
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
	// Back to the uploads once signed in, or to `home` (Video Vault's page).
	waitForLogin(home?: string): Promise<void>;
	readonly live?: LiveActions;
	// Uploads of PC recordings: the streamer of the recording, if its label names one. Which
	// download list it belongs in is the user's choice.
	uploadStreamer?(video: Video): string | undefined;
	// Video Vault lists several sites in one order (and keeps its last complete list to open
	// with), marks rows by site where that is ambiguous, and names a viewer route's video
	// before the list arrives.
	order?(videos: Video[]): Video[];
	marks?(videos: Video[]): Map<string, string>;
	routeVideo?(path: string): Video | undefined;
}

// A streamer in one of the PC's download lists.
export interface ListEntry {
	readonly list: LocalProvider;
	readonly identifier: string;
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
