export const PROVIDERS = ['tslive', 'ladder', 'fmp4'] as const;
export type LocalProvider = (typeof PROVIDERS)[number];
export type Provider = LocalProvider | 'oldhost' | 'videohost' | 'tslive-live' | 'vault';
export const DEFAULT_PROVIDER: Provider = 'tslive';

// Set only by the bundled iPhone shell. Safari keeps its same-origin URLs.
declare global {
	interface Window {
		tsliveNative?: { serverURL: string };
		// Video Vault: the app's PC download-list requests (apps/ios VideoApp/DownloadList.swift),
		// and Video Vault's reads of its other upload site (VideoApp/SiteWorker.swift).
		webkit?: { messageHandlers?: {
			downloadList?: { postMessage(message: unknown): Promise<unknown> };
			vaultSite?: { postMessage(message: unknown): Promise<unknown> };
		} };
	}
}
const mediaOrigin = typeof window === 'undefined' ? '' : window.tsliveNative?.serverURL ?? '';

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
	tslive: { member: '/api/tslive/member', exists: '/api/tslive/exists', add: '/api/tslive/add', remove: '/api/tslive/remove' },
	ladder: { member: '/api/ladder/member', exists: '/api/ladder/exists', add: '/api/ladder/add', remove: '/api/ladder/remove' },
	fmp4: { member: '/api/fmp4/member', exists: '/api/fmp4/exists', add: '/api/fmp4/add', remove: '/api/fmp4/remove' }
} as const;

// The PC's website, for online pages that use its download lists (they run on another origin).
export const PC_SERVER = 'https://192.168.1.197:9999';

export const BPS_ESTIMATE = (2300 * 1000) / 8;

export const IS_IOS =
	/iPhone|iPad|iPod/.test(navigator.userAgent) ||
	(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const USE_NATIVE_HLS = IS_IOS;
