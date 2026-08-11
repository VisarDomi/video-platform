export const VIDEO_TYPES = {
    ORIGINAL: "original",
    EDITED: "edited",
} as const;

export const DESTINATIONS = {
    TRASH: "trash",
    ORIGINAL: VIDEO_TYPES.ORIGINAL,
    EDITED: VIDEO_TYPES.EDITED,
} as const;

export const ALL_VIDEO_PATHS_TYPES = {
    ORIGINAL: VIDEO_TYPES.ORIGINAL,
    EDITED: VIDEO_TYPES.EDITED,
} as const;

export const FILE_NAMES = {
    PACKAGE_JSON: "package.json",
    LIVE_STATUS: "live-status.json",
    HLS_PLAYLIST: "playlist.m3u8",
    INDEX_HTML: "index.html",
} as const;

export const DIRECTORIES = {
    SHARED_STATE_BASE: ".local/share/video-services",
} as const;

export const DEFAULT_PATHS = {
    HOME_VIDEOS: "Videos",
    DOWNLOADS: "downloads",
    TANGO: "tango",
    DOWNLOADER: "downloader",
    EDITOR: "editor",
    EDITED: "edited",
    TRASH: "trash",
    CONVERTER: "converter",
    CONVERTED: "converted",
} as const;

export const FILE_EXTENSIONS = {
    TS: ".ts",
    MP4: ".mp4",
} as const;

export const HLS = {
    HEADER: "#EXTM3U",
    VERSION: "#EXT-X-VERSION:7",
    MEDIA_SEQUENCE: "#EXT-X-MEDIA-SEQUENCE:0",
    TARGET_DURATION_PREFIX: "#EXT-X-TARGETDURATION:",
    INF_PREFIX: "#EXTINF:",
    MAP_PREFIX: "#EXT-X-MAP:",
    DISCONTINUITY: "#EXT-X-DISCONTINUITY",
    ENDLIST: "#EXT-X-ENDLIST",
    INIT_SEGMENT: "init.mp4",
    DEFAULT_TARGET_DURATION: 10,
    DURATION_DECIMAL_PRECISION: 3,
} as const;

export const API = {
    PORT: 7973,
    HOST: "0.0.0.0",
    JSON_LIMIT: "10mb",
    MESSAGES: {
        INVALID_REQUEST_FILENAME_REQUIRED: "Invalid request: filename is required.",
        INVALID_REQUEST_FILENAME_SEGMENTS_REQUIRED: "Invalid request: filename and segments are required.",
        INVALID_REQUEST_DESTINATION: "Invalid request: filename and destination are required. destination can only have the values trash, original, edited",
        INVALID_REQUEST_SEGMENT_NAME: "Invalid request: filename is required and segment name should end in .ts or .mp4",
        VIDEO_NOT_FOUND: "Video not found.",
        SEGMENT_NOT_FOUND: "Segment not found.",
        COULD_NOT_SERVE_SEGMENT: "Could not serve segment.",
    },
    HEADERS: {
        CONTENT_TYPE: "Content-Type",
        CACHE_CONTROL: "Cache-Control",
        HLS_CONTENT_TYPE: "application/vnd.apple.mpegurl",
        TS_CONTENT_TYPE: "video/mp2t",
        MP4_CONTENT_TYPE: "video/mp4",
        NO_CACHE: "max-age=0, no-cache, no-store, must-revalidate",
    },
} as const;

export const LOGS = {
    MESSAGES: {
        LAN_ACCESS: (address: string, port: number) => `LAN Access: https://${address}:${port}`,
        MOVE_ERROR: "File is already at the destination.",
        DESTINATION_ERROR: "Destination can only be trash, original, or edited.",
    },
} as const;

export const ERROR_NAMES = {
    FILE_NOT_FOUND: "FileNotFoundError",
    MOVE: "MoveError",
    SEGMENT: "SegmentError",
} as const;

export const MISC = {
    ENCODING_UTF8: "utf-8",
    NETWORK_INTERFACE_IPV4: "IPv4",
    ERROR_CODE: {
        ENOENT: "ENOENT",
        ECONNABORTED: "ECONNABORTED",
    },
    JS_TYPES: {
        STRING: "string",
    },
    EMPTY_STRING: "",
    RADIX_DECIMAL: 10,
    JSON_INDENT: 2,
    NEW_LINE: "\n",
} as const;
