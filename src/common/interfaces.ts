export interface Download {
    streamerId: string;
    alias: string;
    liveUrl: string | null;
    tsFilePath: string | null;
    segmentsDirPath: string | null;
}
