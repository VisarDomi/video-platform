import { TargetManager } from "../../common/targetManager.js";

const TANGO_URL_PREFIX = "https://tango.me/";

function parseTangoIdentifier(line: string): string | null {
    if (!line?.startsWith(TANGO_URL_PREFIX)) return null;
    // Format: "https://tango.me/{accountId} {alias}"
    // Extract accountId (stable ID) — alias after the space is for human readability only
    const rest = line.slice(TANGO_URL_PREFIX.length);
    const spaceIdx = rest.indexOf(" ");
    return spaceIdx !== -1 ? rest.slice(0, spaceIdx) : rest;
}

export function createTangoTargetManager(): TargetManager {
    return TargetManager.create({
        label: "Tango",
        fileName: "tango.txt",
        parseIdentifier: parseTangoIdentifier,
        defaultComment: "# Add Tango URLs here: https://tango.me/{accountId} {alias}",
    });
}

export { TargetManager };
