import { chmod, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PipelineConfig } from "../config.js";
import { readProviderCredentials, assertUploadProvider, type ActiveUploadProvider } from "../config/uploadProviders.js";
import { loadDestinationPlugin, parseDestinations, type Destination, type DestinationEntry, type DestinationPlugin, type UplinkSetting } from "sdk";
import { RemoteDestination } from "./remoteDestination.js";
import { deployedRunnerCommit } from "../uplink/runnerConnection.js";
import { sitesFilePath } from "shared";
import { readFile } from "node:fs/promises";
import { shutdownSignal } from "../shutdown.js";

// The destination the sites file names for this provider ID, created on the
// pipeline-owned browser profile (everyday and shared profiles are refused here, before
// the plug-in sees a path) with the provider's credentials.
export async function createProviderUploader(config: PipelineConfig, provider: ActiveUploadProvider): Promise<Destination> {
    return (await openDestination(config, provider)).destination;
}

// The destination, its plug-in and its sites-file entry.
export async function openDestination(config: PipelineConfig, provider: ActiveUploadProvider): Promise<{
    destination: Destination; plugin: DestinationPlugin; entry: DestinationEntry; stateDir: string;
}> {
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
    const destination = plugin.createDestination({
        config: entry.config ?? {},
        stateDir,
        browser: { executablePath: config.chromiumExecutablePath, profilePath },
        credentials: () => readProviderCredentials(config.credentialsFilePath, provider),
        stopSignal: shutdownSignal,
    });
    return { destination, plugin, entry, stateDir };
}

// The destination for an upload that leaves from the setting's uplink: the runner on that
// network's machine sends the carrier's copy of the file (see remoteDestination.ts).
export async function createUplinkUploader(config: PipelineConfig, provider: ActiveUploadProvider, uplink: UplinkSetting,
    file: { name: string; sha256: string }, carrierRoot?: string): Promise<Destination> {
    const { destination, plugin, entry, stateDir } = await openDestination(config, provider);
    return new RemoteDestination(destination, plugin, entry, stateDir, {
        uplink,
        carrier: { root: carrierRoot ?? uplink.carrier.remoteMount, id: carrierId(uplink) },
        file,
        expectedCommit: await deployedRunnerCommit(config.databasePath),
        stopSignal: shutdownSignal,
    });
}

// The ID a carrier's carrier.json names: its label, or a directory carrier's folder name.
export function carrierId(uplink: UplinkSetting): string {
    return uplink.carrier.label ?? path.basename(uplink.carrier.path!);
}

export type { Destination };
