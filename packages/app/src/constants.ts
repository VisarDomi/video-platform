export const PROVIDERS = ['tango', 'fc2', 'sc'] as const;
export type LocalProvider = (typeof PROVIDERS)[number];
export type Provider = LocalProvider | 'xvideos' | 'porntrex' | 'tango-live' | 'vault';
export const DEFAULT_PROVIDER: Provider = 'tango';

// Set only by the bundled iPhone shell. Safari keeps its same-origin URLs.
declare global {
	interface Window {
		tangoNative?: { serverURL: string };
		// Video Vault: the app's PC download-list requests (apps/ios VideoApp/DownloadList.swift),
		// and Video Vault's reads of its other upload site (VideoApp/SiteWorker.swift).
		webkit?: { messageHandlers?: {
			downloadList?: { postMessage(message: unknown): Promise<unknown> };
			vaultSite?: { postMessage(message: unknown): Promise<unknown> };
		} };
	}
}
const mediaOrigin = typeof window === 'undefined' ? '' : window.tangoNative?.serverURL ?? '';

export const VIDEO_TYPE = {
	ORIGINAL: 'original',
	EDITED: 'edited'
} as const;

export const STORAGE_KEYS = {
	PROGRESS_PREFIX: 'video-progress-',
	HIGHLIGHT_PREFIX: 'video-highlight:'
} as const;

export const API = {
	VIDEOS: '/api/videos',
	EDIT: '/api/edit',
	ORIGINAL: (filename: string) => `/api/videos/${encodeURIComponent(filename)}/original`,
	EDITED: (filename: string) => `/api/videos/${encodeURIComponent(filename)}/edited`,
	HLS_PLAYLIST: (provider: string, filename: string) =>
		`${mediaOrigin}/hls/${encodeURIComponent(provider)}/${encodeURIComponent(filename)}/playlist.m3u8`
} as const;

export const LIST_API = {
	tango: { member: '/api/tango/member', exists: '/api/tango/exists', add: '/api/tango/add', remove: '/api/tango/remove' },
	fc2: { member: '/api/fc2/member', exists: '/api/fc2/exists', add: '/api/fc2/add', remove: '/api/fc2/remove' },
	sc: { member: '/api/sc/member', exists: '/api/sc/exists', add: '/api/sc/add', remove: '/api/sc/remove' }
} as const;

// The PC's website, for online pages that use its download lists (they run on another origin).
export const PC_SERVER = 'https://192.168.1.197:9999';

export const BPS_ESTIMATE = (2300 * 1000) / 8;

export const IS_IOS =
	/iPhone|iPad|iPod/.test(navigator.userAgent) ||
	(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const USE_NATIVE_HLS = IS_IOS;
