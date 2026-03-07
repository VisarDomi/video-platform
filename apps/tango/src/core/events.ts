export const Events = {
    UI: {
        FOLLOW: "ui:follow",
        UNFOLLOW: "ui:unfollow",
        BLOCK: "ui:block",
        NEXT: "ui:next",
        PREVIOUS: "ui:previous",
        TOGGLE_MUTE: "ui:toggleMute",
        SHOW_LIST: "ui:showList",
        PLAY_STREAMER: "ui:playStreamer",
        SET_UI_VISIBLE: "ui:setUiVisible",
    },
    VIDEO: {
        MULTI_BROADCAST_FETCH_START: "video:multiBroadcastFetchStart",
        MULTI_BROADCAST_FETCH_END: "video:multiBroadcastFetchEnd",
    },
    APP: {
        UPDATE_UI: "app:updateUI",
        STATE_CHANGED: "app:stateChanged",
        LOAD_MORE_STREAMERS: "app:loadMoreStreamers",
        REMOVE_STREAMER: "app:removeStreamer",
        INSERT_STREAMERS_AFTER_CURRENT: "app:insertStreamersAfterCurrent",
    },
    DEBUG: {
        LOG: "debug:log",
    },
} as const;