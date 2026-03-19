import * as crypto from "crypto";
import * as path from "path";
import * as url from "url";
import { FileSystemManager } from "../../../common/fileSystemManager.js";
import logger from "../../../common/logger.js";
import * as utils from "../../../common/utils.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = utils.findProjectRoot(__dirname);

const MOUFLON_FILE_ATTR = "#EXT-X-MOUFLON:URI:";
const MOUFLON_TAG = "#EXT-X-MOUFLON:";
const MOUFLON_FILENAME = "media.mp4";
const KEYS_PATH = path.resolve(projectRoot, "stripchat_mouflon_keys.json");

let mouflonKeys: Record<string, string> = {};
const sha256Cache = new Map<string, Buffer>();

export async function loadMouflonKeys(): Promise<void> {
    const data = await FileSystemManager.readJsonFile<Record<string, string>>(KEYS_PATH);
    if (data) {
        mouflonKeys = data;
        logger.info(`[SC] Loaded ${Object.keys(mouflonKeys).length} mouflon key(s)`);
    } else {
        logger.warn(`[SC] Could not load mouflon keys from ${KEYS_PATH}`);
    }
}

function getSha256(key: string): Buffer {
    let hash = sha256Cache.get(key);
    if (!hash) {
        hash = crypto.createHash("sha256").update(key, "utf-8").digest();
        sha256Cache.set(key, hash);
    }
    return hash;
}

function decodeSegmentUri(encryptedB64: string, decKey: string): string {
    const hashBytes = getSha256(decKey);
    // Reverse the base64 string and pad with '=='
    const reversed = encryptedB64.split("").reverse().join("") + "==";
    const encrypted = Buffer.from(reversed, "base64");

    // XOR with cycling SHA256 hash
    const decoded = Buffer.alloc(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
        decoded[i] = encrypted[i] ^ hashBytes[i % hashBytes.length];
    }
    return decoded.toString("utf-8");
}

interface MouflonParams {
    psch: string;
    pkey: string;
    pdkey: string | null;
}

function getMouflonParams(content: string): MouflonParams {
    let start = 0;

    while (true) {
        const slice = content.slice(start);
        const idx = slice.indexOf(MOUFLON_TAG);
        if (idx < 0) break;

        const absIdx = start + idx;
        const lineEnd = content.indexOf("\n", absIdx);
        const line = (lineEnd >= 0 ? content.slice(absIdx, lineEnd) : content.slice(absIdx)).trim();

        // Format: #EXT-X-MOUFLON:URI:...:psch:pkey  or  #EXT-X-MOUFLON:psch:pkey
        // Split by ':' — [#EXT-X-MOUFLON, ...parts, psch, pkey]
        const parts = line.split(":");
        if (parts.length >= 4) {
            const psch = parts[parts.length - 2];
            const pkey = parts[parts.length - 1];
            const pdkey = mouflonKeys[pkey] ?? null;

            if (pdkey && psch === "v1") {
                return { psch, pkey, pdkey };
            }
        }

        start = absIdx + MOUFLON_TAG.length;
    }

    // Fallback: use first available key with v2
    const entries = Object.entries(mouflonKeys);
    if (entries.length > 0) {
        const [pkey, pdkey] = entries[0];
        return { psch: "v2", pkey, pdkey };
    }

    return { psch: "", pkey: "", pdkey: null };
}

/**
 * Decrypt mouflon-encrypted m3u8 content.
 * Replaces encrypted segment URIs with decrypted ones.
 */
export function decryptM3u8(content: string): string {
    const { pdkey } = getMouflonParams(content);
    if (!pdkey) {
        logger.warn("[SC] No mouflon decryption key available");
        return content;
    }

    const lines = content.split("\n");
    let decoded = "";
    let lastDecodedUri: string | null = null;

    for (const line of lines) {
        if (line.startsWith(MOUFLON_FILE_ATTR)) {
            const uri = line.slice(MOUFLON_FILE_ATTR.length);
            const parts = uri.split("_");
            // The encrypted part is second-to-last segment separated by '_'
            if (parts.length >= 2) {
                const encryptedPart = parts[parts.length - 2];
                const decodedPart = decodeSegmentUri(encryptedPart, pdkey);
                lastDecodedUri = uri.replace(encryptedPart, decodedPart);
            }
        } else if (line.endsWith(MOUFLON_FILENAME) && lastDecodedUri) {
            decoded += lastDecodedUri + "\n";
            lastDecodedUri = null;
        } else {
            decoded += line + "\n";
        }
    }

    return decoded;
}

/**
 * Extract psch and pkey from mouflon tags for URL construction.
 */
export function getMouflonUrlParams(content: string): { psch: string; pkey: string } {
    const { psch, pkey } = getMouflonParams(content);
    return { psch, pkey };
}
