export type VideoItem = {
    filename: string;
    type: "original" | "edited";
    size: number;
    duration: number;
    isLive: boolean;
};
