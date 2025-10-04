// public/types.ts

/**
 * Defines the type of video, either original or an edited version.
 */
export type VideoType = "original" | "edited";

/**
 * Represents a single video file in the application.
 */
export interface Video {
    filename: string;
    type: VideoType;
    duration: number | null;
}

/**
 * Represents the entire state of the frontend application.
 */
export interface AppState {
    view: "list" | "video";
    isLoading: boolean;
    videoList: Video[];
    filter: string;
    currentVideo: Video | null;
    currentVideoStartTime: number;
    lastPlayedVideo: Video | null;
    segments: number[];
    playerMode: "view" | "edit";
}

/**

 * A map of cached DOM elements for quick access.
 */
export interface DomElements {
    listView: HTMLElement;
    videoView: HTMLElement;
    listContainer: HTMLElement;
    videoItemsWrapper: HTMLElement;
    searchContainer: HTMLElement;
    videoPlayer: HTMLVideoElement;
    streamerNameEl: HTMLElement;
    searchInput: HTMLInputElement;
    clearSearchBtn: HTMLButtonElement;
    getDurationsBtn: HTMLButtonElement;
    quadrantOverlay: HTMLElement;
    topBar: HTMLElement;
    progressBar: HTMLElement;
    progressFill: HTMLElement;
    playerControlsContainer: HTMLElement;
    muteBtn: HTMLButtonElement;
    addPointBtn: HTMLButtonElement;
    timeDisplay: HTMLElement;
    goBackBtn: HTMLButtonElement;
    modeOrUndoBtn: HTMLButtonElement;
    videoOkBtn: HTMLButtonElement;
    deleteOrCutBtn: HTMLButtonElement;
}
