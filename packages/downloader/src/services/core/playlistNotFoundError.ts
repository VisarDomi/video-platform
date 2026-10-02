// Providers opt into treating a missing live playlist as the end of a recording.
// Keep this request-local: one provider instance serves many concurrent streams.
export class PlaylistNotFoundError extends Error {
    constructor(public readonly url: string) {
        super(`Playlist returned HTTP 404: ${url}`);
        this.name = "PlaylistNotFoundError";
    }
}
