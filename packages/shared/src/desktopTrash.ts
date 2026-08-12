import { spawn } from "node:child_process";

export async function moveToDesktopTrash(targetPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn("gio", ["trash", targetPath], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8_192); });
        child.once("error", reject);
        child.once("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`gio trash failed (${code ?? "unknown"}): ${stderr.trim()}`));
        });
    });
}
