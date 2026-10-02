export enum Handler {
    Home,
    Stream,
}

export class AuthenticationRequiredError extends Error {}

export type Route =
    | { handler: Handler.Home }
    | { handler: Handler.Stream; streamId: string };

export interface Stream {
    // Shared viewer entry. For VOD, streamerId identifies the upload, streamId
    // is its native page path, and masterListUrl stays empty until resolution.
    streamerId: string;
    streamId: string;
    masterListUrl: string;
    firstName: string;
    alias?: string;
    isFollowing: boolean;
    parentStreamerId?: string;
}

export interface Provider {
    readonly playback: "live" | "video";
    readonly homeUrl: string;
    readonly listTitle: string;
    readonly takeover?: "rewrite" | "replace";
    readonly nativeLogin?: { path: string; wait: () => Promise<void> };
    matchRoute(pathname: string): Route | null;
    streamUrl(streamId: string): string;
    startAuthentication(): Promise<void>;
    fetchStreams(): Promise<Stream[]>;
    fetchStreamPage?(cursor?: string, signal?: AbortSignal): Promise<{ streams: Stream[]; nextPage?: string }>;
    // Resolve short-lived media URLs on slot load; never persist signed sources.
    resolvePlayback?(stream: Stream): Promise<{ url: string; quality: string }>;
    fetchCostreamers?(stream: Stream): Promise<Stream[]>;
    enrichAll(streams: Stream[]): Promise<Stream[]>;
    enrich(stream: Stream): Promise<Stream>;
    follow?(streamerId: string): Promise<void>;
    unfollow?(streamerId: string): Promise<void>;
    block?(streamerId: string): Promise<void>;
    fetchDownloadList?(): Promise<Set<string>>;
    addToDownloadList?(streamerId: string): Promise<void>;
    removeFromDownloadList?(streamerId: string): Promise<void>;
}
