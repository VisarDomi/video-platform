import { TargetManager } from "../../common/targetManager.js";

const TANGO_URL_PREFIX = "https://tango.me/";

function parseTangoIdentifier(line: string): string | null {
    if (!line) return null;
    // Format: "https://tango.me/{accountId} {alias}"
    if (line.startsWith(TANGO_URL_PREFIX)) {
        const rest = line.slice(TANGO_URL_PREFIX.length);
        const spaceIdx = rest.indexOf(" ");
        return spaceIdx !== -1 ? rest.slice(spaceIdx + 1) : null;
    }
    return null;
}

export function createTangoTargetManager(): TargetManager {
    return TargetManager.create({
        label: "Tango",
        fileName: "tango.txt",
        parseIdentifier: parseTangoIdentifier,
        defaultComment: "# Add Tango aliases here, one per line",
    });
}

export { TargetManager };
