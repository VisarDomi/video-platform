import type { LiveCapture, Logger, ProviderLiveStream, ProviderSnapshot, RunningCaptures, Target } from "sdk";
import type { Fmp4Api } from "./api.js";
import type { Fmp4Config } from "./config.js";
import type { NameHistory } from "./names.js";
import type { Fmp4Provider } from "./provider.js";

// Who is live: one bulk status check of the listed channels every pollIntervalMs (end of
// one poll to the start of the next). Only a public, live show is recordable; private,
// group and offline channels are terminal. The status's statusSince is the recording
// identity: it moves at every status change, so a show that went private and came back
// is a new recording. The channel's current name (the site lets channels rename) is
// recorded durably and names the capture's folder. Captures start in the order of the
// status response.
export class Fmp4Capture implements LiveCapture {
    public readonly pollIntervalMs: number;
    public readonly mediaFormat = "fmp4" as const;
    public readonly pollErrorMessage = "Error reading channel statuses";

    constructor(
        private readonly api: Pick<Fmp4Api, "statuses">,
        public readonly provider: Fmp4Provider,
        private readonly names: NameHistory,
        config: Fmp4Config,
        private readonly log: Logger,
    ) {
        this.pollIntervalMs = config.pollIntervalMs;
    }

    public async lookup(targets: Target[], _running: RunningCaptures): Promise<ProviderSnapshot | null> {
        const listed = targets.filter((target) => target.id !== "");
        // Nothing resolved to a channel yet: no request, no snapshot.
        if (listed.length === 0) return null;
        const statuses = await this.api.statuses(listed.map((target) => target.id));
        if (!statuses) return null;
        this.provider.noteStatuses(statuses);
        const snapshot: ProviderSnapshot = {
            observedAt: Date.now(),
            live: new Map(),
            terminalTargetIds: new Set(),
            unidentifiedTargetIds: new Set(),
            startOrder: [...statuses.keys()],
        };
        for (const target of listed) {
            const status = statuses.get(target.id);
            if (status) await this.names.observe(target, status.name);
            if (status?.status !== "public" || !status.live) {
                snapshot.terminalTargetIds.add(target.id);
                continue;
            }
            if (!status.statusSince) {
                // resolveMaster reads the identity from the stream API.
                snapshot.unidentifiedTargetIds!.add(target.id);
                continue;
            }
            snapshot.live.set(target.id, { targetId: target.id, alias: status.name, recordingId: status.statusSince, masterPlaylistUrl: "" });
        }
        return snapshot;
    }

    public async resolveMaster(live: ProviderLiveStream): Promise<ProviderLiveStream | null> {
        const opened = await this.provider.openStream(live.targetId);
        if (!opened) {
            this.log.warn(`${live.alias} (${live.targetId}) is public but has no playable stream; not starting`);
            return null;
        }
        if (!opened.recordingId) {
            this.log.warn(`${opened.alias} (${live.targetId}): public stream has no statusSince; refusing unsafe capture`);
            return null;
        }
        this.log.debug(`${opened.alias} is public. Starting download...`);
        return { targetId: live.targetId, alias: opened.alias, recordingId: opened.recordingId, masterPlaylistUrl: opened.masterUrl };
    }

    // A folder is named after the channel's name when its capture started, which may be
    // an older one than the list's.
    public targetIdForFolderAlias(alias: string, targets: readonly Target[]): string | null {
        return targets.find((target) => target.id !== "" && target.label === alias)?.id ?? this.names.targetFor(alias, targets);
    }
}
