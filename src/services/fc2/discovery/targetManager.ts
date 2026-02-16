import { TargetManager } from "../../common/targetManager.js";

function parseFc2Identifier(line: string): string | null {
    if (line.includes("live.fc2.com")) {
        const match = line.match(/live\.fc2\.com\/(\d+)/);
        return match ? match[1] : null;
    }
    if (/^\d+$/.test(line)) {
        return line;
    }
    return null;
}

export function createFc2TargetManager(): TargetManager {
    return TargetManager.create({
        label: "FC2",
        fileName: "fc2.txt",
        parseIdentifier: parseFc2Identifier,
        defaultComment: "# Add FC2 Channel IDs here, one per line",
    });
}

// Re-export TargetManager type for consumers
export { TargetManager };
