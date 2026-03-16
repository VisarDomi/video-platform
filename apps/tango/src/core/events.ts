export const Events = {
    UI: {
        FOLLOW: "ui:follow",
        UNFOLLOW: "ui:unfollow",
        BLOCK: "ui:block",
        ADD_TO_DOWNLOAD_LIST: "ui:addToDownloadList",
        REMOVE_FROM_DOWNLOAD_LIST: "ui:removeFromDownloadList",
        NEXT: "ui:next",
        PREVIOUS: "ui:previous",
        TOGGLE_MUTE: "ui:toggleMute",
        SHOW_LIST: "ui:showList",
        PLAY_STREAMER: "ui:playStreamer",
        SET_UI_VISIBLE: "ui:setUiVisible",
        CAPTURE_SCROLL_ANCHOR: "ui:captureScrollAnchor",
    },
    VIDEO: {
        MULTI_BROADCAST_FETCH_START: "video:multiBroadcastFetchStart",
        MULTI_BROADCAST_FETCH_END: "video:multiBroadcastFetchEnd",
    },
    APP: {
        UPDATE_UI: "app:updateUI",
        STATE_CHANGED: "app:stateChanged",
        REMOVE_STREAMER: "app:removeStreamer",
        INSERT_STREAMERS_AFTER_CURRENT: "app:insertStreamersAfterCurrent",
    },
    DEBUG: {
        LOG: "debug:log",
    },
} as const;