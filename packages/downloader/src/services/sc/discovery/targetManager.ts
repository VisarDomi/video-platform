import { TargetManager } from "../../common/targetManager.js";

function parseScIdentifier(line: string): string | null {
    let username = line;
    if (line.includes("stripchat.com/")) {
        const parts = line.split("stripchat.com/");
        if (parts[1]) {
            username = parts[1].split("/")[0].split("?")[0];
        }
    }
    return username || null;
}

export function createScTargetManager(): TargetManager {
    return TargetManager.create({
        label: "SC",
        fileName: "sc.txt",
        parseIdentifier: parseScIdentifier,
        defaultComment: "# Add StripChat Usernames here, one per line",
    });
}

export { TargetManager };
