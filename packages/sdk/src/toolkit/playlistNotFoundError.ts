const BRAND = Symbol.for("video-platform.sdk.PlaylistNotFoundError");

// Thrown by a download session's fetchPlaylist when the site answers that the live
// playlist is gone (for a site where that means the broadcast ended). The core then ends
// the recording instead of retrying. Keep it request-local: one provider serves many
// concurrent streams.
//
// `instanceof` checks a brand, so the core recognizes the error even if a plug-in was
// built against another copy of this package.
export class PlaylistNotFoundError extends Error {
    constructor(public readonly url: string) {
        super(`Playlist returned HTTP 404: ${url}`);
        this.name = "PlaylistNotFoundError";
        Object.defineProperty(this, BRAND, { value: true });
    }

    static [Symbol.hasInstance](value: unknown): boolean {
        return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
    }
}
