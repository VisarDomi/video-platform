// A site ID of the sites file (the server lists them: services/sites.ts).
export type LocalProvider = string;
export type Provider = LocalProvider;

const mediaOrigin = '';

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

// A site's download-list endpoints.
export type ListAction = 'member' | 'exists' | 'add' | 'remove';
export const LIST_API = (site: string, action: ListAction): string => `/api/${encodeURIComponent(site)}/${action}`;

// The PC's website, for online pages that use its download lists (they run on another origin).
export const PC_SERVER = 'https://192.168.1.197:9999';

export const BPS_ESTIMATE = (2300 * 1000) / 8;

export const IS_IOS =
	/iPhone|iPad|iPod/.test(navigator.userAgent) ||
	(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const USE_NATIVE_HLS = IS_IOS;
