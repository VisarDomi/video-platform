export const PROVIDERS = ['tango', 'fc2', 'sc'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const DEFAULT_PROVIDER: Provider = 'tango';

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
		`/hls/${encodeURIComponent(provider)}/${encodeURIComponent(filename)}/playlist.m3u8`
} as const;

export const LIST_API = {
	tango: { list: '/api/tango/list', add: '/api/tango/add', remove: '/api/tango/remove' },
	fc2: { list: '/api/fc2/list', add: '/api/fc2/add', remove: '/api/fc2/remove' },
	sc: { list: '/api/sc/list', add: '/api/sc/add', remove: '/api/sc/remove' }
} as const;

export const BPS_ESTIMATE = (2300 * 1000) / 8;

export const IS_IOS =
	/iPhone|iPad|iPod/.test(navigator.userAgent) ||
	(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export const USE_NATIVE_HLS = IS_IOS;
