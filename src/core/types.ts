import * as constants from "./constants.js";

export type VideoType = (typeof constants.VIDEO_TYPES)[keyof typeof constants.VIDEO_TYPES];

export type VideoItem = {
    filename: string;
    type: VideoType;
    size: number;
    duration: number;
    isLive: boolean;
};

export interface LiveDownload {
    segmentsDirPath: string;
}

export interface LiveStatus {
    downloads: LiveDownload[];
}

export type Destination = (typeof constants.DESTINATIONS)[keyof typeof constants.DESTINATIONS];
