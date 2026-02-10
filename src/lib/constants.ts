export const PROVIDERS = ['tl', 'tango', 'fc2', 'sc'] as const;
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

export const UI_TEXT = {
	controls: {
		MUTE_ICON: '🔇',
		UNMUTE_ICON: '🔊',
		UNDO_ICON: '↪️',
		CUT_ICON: '✂️',
		OK_ICON: '✅'
	},
	labels: {
		EDITED_SUFFIX: ' (edited)',
		LOADING: 'Loading...',
		NO_VIDEOS: 'No videos found.',
		SEGMENT_START: 'start: ',
		SEGMENT_END: 'end: '
	},
	formats: {
		SEARCH_PLACEHOLDER: 'Filter (regex)...',
		DURATION_PLACEHOLDER: '--:--',
		SIZE_PLACEHOLDER: '-- MiB',
		TIME_PRECISE_PLACEHOLDER: '00:00.000',
		SIZE_UNIT: ' MiB'
	}
} as const;

export const TL_API = {
	STREAMS: '/api/tl/streams',
	FOLLOW: '/api/tl/follow',
	UNFOLLOW: '/api/tl/unfollow',
	BLOCK: '/api/tl/block',
	DOWNLOAD_START: '/api/tl/download/start',
	DOWNLOAD_STOP: '/api/tl/download/stop',
	MULTI_BROADCAST: '/api/tl/multi-broadcast'
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
