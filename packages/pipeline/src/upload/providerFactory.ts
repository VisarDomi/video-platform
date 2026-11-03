import { chmod, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PipelineConfig } from "../config.js";
import { readProviderCredentials, assertUploadProvider, type ActiveUploadProvider } from "../config/uploadProviders.js";
import { ChromiumPorntrexUploader } from "./chromiumPorntrexUploader.js";

export async function createProviderUploader(config: PipelineConfig, provider: ActiveUploadProvider = "porntrex") {
    assertUploadProvider(provider);
    const profilePath = path.resolve(config.porntrexBrowserProfilePath ?? config.browserProfilePath);
    let ancestor = profilePath;
    const missing: string[] = [];
    let actual: string;
    for (;;) {
        try { actual = path.join(await realpath(ancestor), ...missing); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            missing.unshift(path.basename(ancestor));
            ancestor = path.dirname(ancestor);
        }
    }
    for (const name of ["chromium-agent", "chromium"]) {
        const reserved = path.join(os.homedir(), ".config", name);
        const target = await realpath(reserved).catch(() => reserved);
        if ([profilePath, actual].some(p => [reserved, target].some(root => p === root || p.startsWith(root + path.sep)))) {
            throw new Error("The shared agent profile and everyday Chromium profiles are reserved; use the pipeline-owned browser directory");
        }
    }
    const credentials = readProviderCredentials(config.credentialsFilePath, provider);
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await chmod(profilePath, 0o700);
    return new ChromiumPorntrexUploader({
        executablePath: config.chromiumExecutablePath,
        profilePath,
        sessionFilePath: config.porntrexSessionPath,
        ...credentials,
    });
}
