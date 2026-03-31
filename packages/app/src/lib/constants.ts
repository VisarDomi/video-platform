export const PROVIDERS = ['tango', 'fc2', 'sc'] as const;
export const DEFAULT_PROVIDER = PROVIDERS[0];

export const STORAGE_KEYS = {
	LAST_PLAYED_VIDEO: 'last-played-video',
	PROGRESS_PREFIX: 'video-progress-',
	SCROLL_PREFIX: 'scroll-',
	SELECTED_PROVIDER: 'selected-provider'
} as const;

export const VIDEO_TYPE = {
	ORIGINAL: 'original',
	EDITED: 'edited'
} as const;

export const API = {
	VIDEOS: '/api/videos',
	EDIT: '/api/edit',
	TRASH: (filename: string) => `/api/videos/${encodeURIComponent(filename)}/trash`,
	ORIGINAL: (filename: string) => `/api/videos/${encodeURIComponent(filename)}/original`,
	EDITED: (filename: string) => `/api/videos/${encodeURIComponent(filename)}/edited`,
	HLS_PLAYLIST: (filename: string) => `/hls/${encodeURIComponent(filename)}/playlist.m3u8`
} as const;

export const SC_API = {
	LIST: '/api/sc/list',
	ADD: '/api/sc/add',
	REMOVE: '/api/sc/remove'
} as const;

export const FC2_API = {
	LIST: '/api/fc2/list',
	ADD: '/api/fc2/add',
	REMOVE: '/api/fc2/remove'
} as const;

export const TANGO_LIST_API = {
	LIST: '/api/tango/list',
	ADD: '/api/tango/add',
	REMOVE: '/api/tango/remove'
} as const;

export const HLS = {
	TS_EXTENSION: '.ts',
	EXTINF_PREFIX: '#EXTINF:'
} as const;

export const BPS_ESTIMATE = (2300 * 1000) / 8;

export const IS_IOS =
	typeof navigator !== 'undefined' &&
	(/iPhone|iPad|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

export const USE_NATIVE_HLS = IS_IOS;

export const SWIPE_THRESHOLD = 0.15;
export const DEADZONE_RATIO = 0.013;
export const EDGE_ZONE_RATIO = 0.077;
