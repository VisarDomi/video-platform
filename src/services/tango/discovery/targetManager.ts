import { TargetManager } from "../../common/targetManager.js";

function parseTangoIdentifier(line: string): string | null {
    // Bare aliases — just the trimmed line itself
    return line || null;
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
