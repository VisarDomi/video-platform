export const PROVIDERS = ['tslive', 'ladder', 'fmp4'] as const;
export type LocalProvider = (typeof PROVIDERS)[number];
export type Provider = LocalProvider | 'oldhost';
export const DEFAULT_PROVIDER: Provider = 'tslive';

// Set only by the bundled iPhone shell. Safari keeps its same-origin URLs.
declare global {
	interface Window { tsliveNative?: { serverURL: string } }
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
	tslive: { list: '/api/tslive/list', add: '/api/tslive/add', remove: '/api/tslive/remove' },
	ladder: { list: '/api/ladder/list', add: '/api/ladder/add', remove: '/api/ladder/remove' },
	fmp4: { list: '/api/fmp4/list', add: '/api/fmp4/add', remove: '/api/fmp4/remove' }
} as const;

export const BPS_ESTIMATE = (2300 * 1000) / 8;

export const IS_IOS =
	/iPhone|iPad|iPod/.test(navigator.userAgent) ||
	(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const USE_NATIVE_HLS = IS_IOS;
