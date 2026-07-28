const GATEWAY_BASE_URL = "https://gateway.tango.me";
const API_BASE_URL = `${GATEWAY_BASE_URL}/proxycador/api/public/v1`;

export const CONSTANTS = {
    API: {
        REFRESH_ENDPOINT: `${GATEWAY_BASE_URL}/session-service/public/v2/session/web/refresh`,
        BLOCK_LIST: `${GATEWAY_BASE_URL}/abregistrar/connection/v1/blocklist`,
        MY_FOLLOWINGS: `${GATEWAY_BASE_URL}/discovery/v3/followings/me/list`,
        RECOMMENDATOR_FOLLOWING: `${GATEWAY_BASE_URL}/recommendator/social/v2/list/following?includeAlias=true`,
        RECOMMENDATOR_RECOMMENDATIONS: `${GATEWAY_BASE_URL}/recommendator/social/v2/list/following_recommendations`,
        ALIAS: `${GATEWAY_BASE_URL}/proxycador/api/profiles/v2/single`,
        BATCH_ALIAS: `${GATEWAY_BASE_URL}/proxycador/api/public/v1/profiles/v2/batch`,
        TOKEN_DATA: `${API_BASE_URL}/live/stream/v1/tokenData`,
        FOLLOW_ADD: `${API_BASE_URL}/follow/add`,
        FOLLOW_REMOVE: `${API_BASE_URL}/follow/remove`,
        STREAM_WATCH: `${API_BASE_URL}/live/stream/v2/watch?requestId=`,
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
        FOLLOWINGS_PAGE_SIZE: 5000,
    },
    VIDEO_PLATFORM: {
        BASE_URL: "https://192.168.1.197:7973",
    },
};
