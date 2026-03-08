const API_BASE_URL = "https://gateway.tango.me/proxycador/api/public/v1";

export const CONSTANTS = {
    API: {
        TOKEN_DATA: `${API_BASE_URL}/live/stream/v1/tokenData`,
        FOLLOW_ADD: `${API_BASE_URL}/follow/add`,
        FOLLOW_REMOVE: `${API_BASE_URL}/follow/remove`,
        BLOCK_LIST: `${API_BASE_URL}/blockList`,
        RECOMMENDATIONS: `${API_BASE_URL}/recommendations/following?tags=`,
        STREAM_WATCH: `${API_BASE_URL}/live/stream/v2/watch?requestId=`,
        ALIAS: "https://gateway.tango.me/proxycador/api/profiles/v2/single",
        BATCH_ALIAS: "https://gateway.tango.me/proxycador/api/public/v1/profiles/v2/batch",
    },
    DOM: {
        SCRIPT_ELEMENT_ID_PREFIX: "donotremove",
        INJECTED_SCRIPT_ID: "donotremove1",
        UI_CONTAINER_ID: "donotremove2",
        HLS_SCRIPT_ID: "donotremove3",
        BODY_ID: "donotremove4",
        HEAD_ID: "donotremove5",
        STYLE_ELEMENT_ID: "donotremove6",

        LIST_VIEW: "listView",
        LIST_CONTAINER: "listContainer",
        VIDEO_ITEMS_WRAPPER: "videoItemsWrapper",
    },
VIDEO: {
        TARGET_RESOLUTION: "RESOLUTION=1280x720",
    },
    USERSCRIPT: {
        MATCH_URL: "https://tango.me/live/recommended",
    },
    APP: {
        FETCH_BATCH_SIZE: 50,
    },
    VIDEO_PLATFORM: {
        BASE_URL: "https://192.168.1.197:7973",
    },
    DEBUG: {
        ENABLED: false,
    },
} as const;