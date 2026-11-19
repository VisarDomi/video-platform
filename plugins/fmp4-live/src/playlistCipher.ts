import { createHash } from "node:crypto";

// The site's obfuscated media playlists. A header tag names the key; each entry carries
// its real URI in a tag, and the URI line after it is a placeholder that serves nothing:
//
//   #EXT-X-OBF-KEY:ID=<keyId>
//   #EXTINF:2.000,
//   #EXT-X-OBF-URI:<check>.<cipher>
//   .../obfuscated.m4s
//
// check = the first 8 hex digits of SHA-256(uri); cipher = base64url(uri XOR keystream),
// keystream = SHA-256("<secret>|<check>|0") || SHA-256("<secret>|<check>|1") || ...
// The check tells a wrong secret from a right one.

const KEY_TAG = "#EXT-X-OBF-KEY:";
const URI_TAG = "#EXT-X-OBF-URI:";

export type DecodedPlaylist =
    | { ok: true; text: string; keyId: string | null; decoded: number }
    | { ok: false; reason: "unknown-key" | "undecodable"; keyId: string | null };

function keystream(secret: string, check: string, length: number): Buffer {
    const blocks: Buffer[] = [];
    for (let i = 0; blocks.length * 32 < length; i++) blocks.push(createHash("sha256").update(`${secret}|${check}|${i}`).digest());
    return Buffer.concat(blocks).subarray(0, length);
}

export function decodeToken(token: string, secret: string): string | null {
    const match = /^([0-9a-f]{8})\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!match) return null;
    const cipher = Buffer.from(match[2], "base64url");
    const stream = keystream(secret, match[1], cipher.length);
    const uri = Buffer.from(cipher.map((byte, i) => byte ^ stream[i])).toString("utf8");
    return createHash("sha256").update(uri).digest("hex").slice(0, 8) === match[1] ? uri : null;
}

export function playlistKeyId(text: string): string | null {
    const line = text.split(/\r?\n/).find((candidate) => candidate.startsWith(KEY_TAG));
    if (!line) return null;
    return /ID=([^,\s]+)/.exec(line.slice(KEY_TAG.length))?.[1]?.replace(/"/g, "") ?? null;
}

// A plain playlist: each decoded URI replaces the placeholder line after its tag, and
// the obfuscation tags are dropped. A playlist without the key tag is returned as is.
export function decodePlaylist(text: string, keys: Readonly<Record<string, string>>): DecodedPlaylist {
    const keyId = playlistKeyId(text);
    if (keyId === null) return { ok: true, text, keyId: null, decoded: 0 };
    const secret = keys[keyId];
    if (secret === undefined) return { ok: false, reason: "unknown-key", keyId };
    const out: string[] = [];
    let pending: string | null = null;
    let decoded = 0;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith(KEY_TAG)) continue;
        if (line.startsWith(URI_TAG)) {
            pending = decodeToken(line.slice(URI_TAG.length).trim(), secret);
            if (pending === null) return { ok: false, reason: "undecodable", keyId };
            continue;
        }
        if (pending !== null && line.trim() !== "" && !line.startsWith("#")) {
            out.push(pending);
            pending = null;
            decoded++;
            continue;
        }
        out.push(line);
    }
    return { ok: true, text: out.join("\n"), keyId, decoded };
}
