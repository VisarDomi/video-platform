const API_BASE_URL = "https://gateway.tango.me/proxycador/api/public/v1";
const GATEWAY_BASE_URL = "https://gateway.tango.me";

export const CONSTANTS = {
    API: {
        TOKEN_DATA: `${API_BASE_URL}/live/stream/v1/tokenData`,
        FOLLOW_ADD: `${API_BASE_URL}/follow/add`,
        FOLLOW_REMOVE: `${API_BASE_URL}/follow/remove`,
        BLOCK_LIST: `${API_BASE_URL}/blockList`,
        MY_FOLLOWINGS: `${GATEWAY_BASE_URL}/discovery/v3/followings/me/list`,
        LIVE_BY_ACCOUNT_IDS: `${GATEWAY_BASE_URL}/stream/social/v2/list/byEncryptedAccountIds`,
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
        MATCH_URLS: [
            "https://tango.me/*",
            "https://www.tango.me/*",
        ],
    },
    APP: {
        FETCH_BATCH_SIZE: 50,
        FOLLOWINGS_PAGE_SIZE: 5000,
        LIVE_CHECK_BATCH_SIZE: 100,
        LIVE_CHECK_BATCH_DELAY_MS: 1000,
    },
    VIDEO_PLATFORM: {
        BASE_URL: "https://192.168.1.197:7973",
    },
    DEBUG: {
        ENABLED: false,
    },
};
