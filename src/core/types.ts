

export type VideoItem = {
    filename: string;
    type: "original" | "edited";
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

export type Destination = "trash" | "original" | "edited"
