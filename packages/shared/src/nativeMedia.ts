import path from "node:path";

export interface NativeMediaSegment {
    readonly index: number;
    readonly name: string;
    readonly durationSeconds: number;
    readonly metadata: readonly string[];
    readonly mapUri: string | null;
    readonly mapLine: string | null;
}

export interface NativeMediaPlaylist {
    readonly header: readonly string[];
    readonly segments: readonly NativeMediaSegment[];
}

export function safeNativeMediaName(name: string): string {
    if (!name || path.basename(name) !== name || /[\r\n"|\\]/.test(name)) {
        throw new Error(`Unsafe local media URI: ${name}`);
    }
    return name;
}

// One interpretation of active MAPs and cuts for capture validation and upload
// preparation. Empty MAP epochs carry no media and must not become input runs.
export function parseNativeMediaPlaylist(content: string): NativeMediaPlaylist {
    const header: string[] = [];
    const segments: NativeMediaSegment[] = [];
    let metadata: string[] = [];
    let mapUri: string | null = null;
    let mapLine: string | null = null;
    for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line === "#EXT-X-ENDLIST") continue;
        if (/^(#EXTM3U|#EXT-X-(VERSION|TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE):|#EXT-X-INDEPENDENT-SEGMENTS$)/.test(line)) {
            header.push(line);
        } else if (line.startsWith("#EXT-X-MAP:")) {
            const match = line.match(/\bURI="([^"]+)"/);
            if (!match) throw new Error(`Unsupported initialization map: ${line}`);
            mapUri = safeNativeMediaName(match[1]);
            mapLine = line;
        } else if (line.startsWith("#")) {
            if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-BYTERANGE:")) {
                throw new Error(`Unsupported native media tag: ${line.split(":")[0]}`);
            }
            metadata.push(line);
        } else {
            const durations = metadata.filter(tag => tag.startsWith("#EXTINF:"));
            const durationSeconds = Number(durations[0]?.match(/^#EXTINF:(\d+(?:\.\d+)?)(?:,.*)?$/)?.[1]);
            if (durations.length !== 1 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
                throw new Error(`Segment ${line} requires one positive #EXTINF duration`);
            }
            segments.push({ index: segments.length, name: safeNativeMediaName(line), durationSeconds,
                metadata, mapUri, mapLine });
            metadata = [];
        }
    }
    return { header, segments };
}

export function nativeMediaBoundary(previous: NativeMediaSegment, current: NativeMediaSegment): boolean {
    return current.index !== previous.index + 1 || current.mapUri !== previous.mapUri
        || current.metadata.includes("#EXT-X-DISCONTINUITY");
}

export function nativeMediaRuns<T extends NativeMediaSegment>(segments: readonly T[],
    extraBoundary?: (previous: T, current: T) => boolean): T[][] {
    const runs: T[][] = [];
    for (const segment of segments) {
        const previous = runs.at(-1)?.at(-1);
        if (!previous || nativeMediaBoundary(previous, segment) || extraBoundary?.(previous, segment)) runs.push([]);
        runs[runs.length - 1].push(segment);
    }
    return runs;
}

export function renderNativeMediaRun(segments: readonly NativeMediaSegment[], sourceDirectory: string): string {
    if (!segments.length) throw new Error("Cannot decode an empty native media run");
    if (segments.some(segment => segment.mapUri !== segments[0].mapUri)) {
        throw new Error("A native decode run cannot span initialization maps");
    }
    const absolute = (name: string) => {
        const resolved = path.join(path.resolve(sourceDirectory), safeNativeMediaName(name));
        if (/[\r\n"]/.test(resolved)) throw new Error("Unsupported media directory");
        return `file://${resolved}`;
    };
    const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-MEDIA-SEQUENCE:0",
        `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(Math.max(...segments.map(s => s.durationSeconds))))}`];
    if (segments[0].mapUri) lines.push(`#EXT-X-MAP:URI="${absolute(segments[0].mapUri)}"`);
    for (const segment of segments) lines.push(`#EXTINF:${segment.durationSeconds.toFixed(9)},`, absolute(segment.name));
    lines.push("#EXT-X-ENDLIST", "");
    return lines.join("\n");
}
