export enum Handler {
    Home,
    Stream,
}

export type Route =
    | { handler: Handler.Home }
    | { handler: Handler.Stream; streamId: string };

export interface Stream {
    streamerId: string;
    streamId: string;
    masterListUrl: string;
    firstName: string;
    alias?: string;
    isFollowing: boolean;
    parentStreamerId?: string;
}

export interface Provider {
    readonly name: string;
    readonly matches: string[];
    matchRoute(pathname: string): Route;
    streamUrl(streamId: string): string;
    startAuthentication(): Promise<() => void>;
    refreshStreamTokens(): Promise<void>;
    fetchStreams(): Promise<Stream[]>;
    fetchCostreamers(stream: Stream): Promise<Stream[]>;
    enrichAll(streams: Stream[]): Promise<Stream[]>;
    enrich(stream: Stream): Promise<Stream>;
    follow(streamerId: string): Promise<void>;
    unfollow(streamerId: string): Promise<void>;
    block(streamerId: string): Promise<void>;
    fetchDownloadList(): Promise<Set<string>>;
    addToDownloadList(streamerId: string): Promise<void>;
    removeFromDownloadList(streamerId: string): Promise<void>;
}
