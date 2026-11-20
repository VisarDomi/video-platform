import { chmod, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PipelineConfig } from "../config.js";
import { readProviderCredentials, assertUploadProvider, type ActiveUploadProvider } from "../config/uploadProviders.js";
import { loadDestinationPlugin, parseDestinations, type Destination } from "sdk";
import { sitesFilePath } from "shared";
import { readFile } from "node:fs/promises";
import { shutdownSignal } from "../shutdown.js";

// The destination the sites file names for this provider ID, created on the
// pipeline-owned browser profile (everyday and shared profiles are refused here, before
// the plug-in sees a path) with the provider's credentials.
export async function createProviderUploader(config: PipelineConfig, provider: ActiveUploadProvider): Promise<Destination> {
    assertUploadProvider(provider);
    const profilePath = path.resolve(config.browserProfilePath);
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
    await mkdir(profilePath, { recursive: true, mode: 0o700 });
    await chmod(profilePath, 0o700);
    const entry = parseDestinations(await readFile(sitesFilePath(), "utf8"), sitesFilePath()).find((destination) => destination.id === provider);
    if (!entry) throw new Error(`The sites file names no destination "${provider}"`);
    const plugin = await loadDestinationPlugin(entry);
    // Each destination's own state, beside the ledger: <pipeline data>/destinations/<id>.
    const stateDir = path.join(path.dirname(config.databasePath), "destinations", provider);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    return plugin.createDestination({
        config: entry.config ?? {},
        stateDir,
        browser: { executablePath: config.chromiumExecutablePath, profilePath },
        credentials: () => readProviderCredentials(config.credentialsFilePath, provider),
        stopSignal: shutdownSignal,
    });
}

export type { Destination };
