// Obfuscated media playlists (fmp4-live). The real segment URI of each entry
// is carried encoded in a tag; the URI line itself is a placeholder that
// serves nothing useful. A header tag names the key; a client that holds the
// secret for that key id decodes the entries.
//
//   #EXT-X-OBF-KEY:ID=<keyId>
//   ...
//   #EXTINF:2.000,
//   #EXT-X-OBF-URI:<token>
//   /edge/a/hls/<stream>/fmp4/obfuscated.m4s
//
// token = <check>.<cipher>, where check = first 8 hex digits of
// SHA-256(uri), and cipher = base64url(uri XOR keystream). The keystream is
// SHA-256("<secret>|<check>|0") || SHA-256("<secret>|<check>|1") || ...
// The check lets a client tell a wrong key from a right one.
import { createHash } from "node:crypto";

export const KEY_TAG = "#EXT-X-OBF-KEY:";
export const URI_TAG = "#EXT-X-OBF-URI:";
export const PLACEHOLDER = "obfuscated.m4s";

function keystream(secret: string, check: string, length: number): Buffer {
    const blocks: Buffer[] = [];
    for (let i = 0; blocks.length * 32 < length; i++) blocks.push(createHash("sha256").update(`${secret}|${check}|${i}`).digest());
    return Buffer.concat(blocks).subarray(0, length);
}

const checkOf = (uri: string) => createHash("sha256").update(uri).digest("hex").slice(0, 8);

export function encodeUri(uri: string, secret: string): string {
    const check = checkOf(uri);
    const plain = Buffer.from(uri, "utf8");
    const ks = keystream(secret, check, plain.length);
    return `${check}.${Buffer.from(plain.map((b, i) => b ^ ks[i])).toString("base64url")}`;
}

/** The URI, or null when the token is malformed or the secret is wrong. */
export function decodeUri(token: string, secret: string): string | null {
    const m = /^([0-9a-f]{8})\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!m) return null;
    const cipher = Buffer.from(m[2], "base64url");
    const ks = keystream(secret, m[1], cipher.length);
    const uri = Buffer.from(cipher.map((b, i) => b ^ ks[i])).toString("utf8");
    return checkOf(uri) === m[1] ? uri : null;
}

export type DecodeResult =
    | { ok: true; playlist: string; keyId: string | null; decoded: number }
    | { ok: false; reason: "unknown-key" | "undecodable"; keyId: string | null };

/** The key id named by a playlist's header tag, if any. */
export function keyIdOf(playlist: string): string | null {
    const line = playlist.split(/\r?\n/).find(l => l.startsWith(KEY_TAG));
    return line ? /ID=([^,\s]+)/.exec(line.slice(KEY_TAG.length))?.[1]?.replace(/"/g, "") ?? null : null;
}

/**
 * Turns an obfuscated media playlist into a plain one: each encoded URI
 * replaces the placeholder after it, and the obfuscation tags are dropped.
 * A playlist without the key tag is returned unchanged.
 */
export function decodePlaylist(playlist: string, keys: Record<string, string>): DecodeResult {
    const keyId = keyIdOf(playlist);
    if (keyId === null) return { ok: true, playlist, keyId: null, decoded: 0 };
    const secret = keys[keyId];
    if (secret === undefined) return { ok: false, reason: "unknown-key", keyId };
    const out: string[] = [];
    let pending: string | null = null;
    let decoded = 0;
    for (const line of playlist.split(/\r?\n/)) {
        if (line.startsWith(KEY_TAG)) continue;
        if (line.startsWith(URI_TAG)) {
            pending = decodeUri(line.slice(URI_TAG.length).trim(), secret);
            if (pending === null) return { ok: false, reason: "undecodable", keyId };
            continue;
        }
        if (pending !== null && line && !line.startsWith("#")) {
            out.push(pending);
            pending = null;
            decoded++;
            continue;
        }
        out.push(line);
    }
    return { ok: true, playlist: out.join("\n"), keyId, decoded };
}
