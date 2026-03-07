import { Events } from "./core/events";

export interface Streamer {
    streamerId: string;
    streamId: string;
    masterListUrl: string;
    firstName: string;
    isFollowing: boolean;
    parentStreamerId?: string; // New field to track origin
}

export interface UIUpdateState {
    alias: string;
    isFollowing: boolean;
}

export type ViewMode = 'list' | 'video';

export interface IApplicationState {
    streamers: Streamer[];
    currentIndex: number;
    currentStreamer: Streamer;
    viewMode: ViewMode;
}

export interface IPlayerStrategy {
    loadSource(url: string): void;
    destroy(): void;
}

export interface DebugLogPayload {
    message: string;
    type: 'success' | 'error' | 'info';
}

export type EventPayloads = {
    [Events.UI.FOLLOW]: void;
    [Events.UI.UNFOLLOW]: void;
    [Events.UI.BLOCK]: void;
    [Events.UI.NEXT]: void;
    [Events.UI.PREVIOUS]: void;
    [Events.UI.TOGGLE_MUTE]: void;
    [Events.UI.SHOW_LIST]: void;
    [Events.UI.PLAY_STREAMER]: string; // streamerId
    [Events.UI.SET_UI_VISIBLE]: boolean;

    [Events.VIDEO.MULTI_BROADCAST_FETCH_START]: void;
    [Events.VIDEO.MULTI_BROADCAST_FETCH_END]: void;

    [Events.APP.UPDATE_UI]: UIUpdateState;
    [Events.APP.STATE_CHANGED]: IApplicationState;
    [Events.APP.LOAD_MORE_STREAMERS]: void;
    [Events.APP.REMOVE_STREAMER]: string; // streamerId

    [Events.DEBUG.LOG]: DebugLogPayload;
};