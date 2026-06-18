import {Events} from "./core/events";

export interface Streamer {
    streamerId: string;
    streamId: string;
    masterListUrl: string;
    firstName: string;
    isFollowing: boolean;
    parentStreamerId?: string;
}

export interface UIUpdateState {
    streamerId: string;
}

export type ViewMode = 'list' | 'video';

export interface IApplicationState {
    streamers: Streamer[];
    currentIndex: number;
    currentStreamer: Streamer;
    previousStreamer: Streamer | undefined;
    nextStreamer: Streamer | undefined;
    viewMode: ViewMode;
    scrollTarget: { streamerId: string; anchorY: number } | null;
}

export interface IPlayerStrategy {
    loadSource(url: string): void;
    resume(): void;
    destroy(): void;
}

export type EventPayloads = {
    [Events.UI.FOLLOW]: void;
    [Events.UI.UNFOLLOW]: void;
    [Events.UI.BLOCK]: void;
    [Events.UI.ADD_TO_DOWNLOAD_LIST]: void;
    [Events.UI.REMOVE_FROM_DOWNLOAD_LIST]: void;
    [Events.UI.NEXT]: void;
    [Events.UI.PREVIOUS]: void;
    [Events.UI.TOGGLE_MUTE]: void;
    [Events.UI.SHOW_LIST]: void;
    [Events.UI.PLAY_STREAMER]: string;
    [Events.UI.SET_UI_VISIBLE]: boolean;
    [Events.UI.CAPTURE_SCROLL_ANCHOR]: number;
    [Events.VIDEO.MULTI_BROADCAST_FETCH_START]: void;
    [Events.VIDEO.MULTI_BROADCAST_FETCH_END]: void;
    [Events.APP.UPDATE_UI]: UIUpdateState;
    [Events.APP.STATE_CHANGED]: IApplicationState;
    [Events.APP.REMOVE_STREAMER]: string;
    [Events.APP.INSERT_STREAMERS_AFTER_CURRENT]: Streamer[];
};