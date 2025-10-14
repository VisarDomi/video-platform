export interface Download {
    streamerId: string;
    alias: string;
    liveUrl: string | null;
    segmentsDirPath: string | null;
}

export interface Tokens {
    st: string | null;
    tt: string | null;
    ttu: string | null;
    tte: string | null;
}
