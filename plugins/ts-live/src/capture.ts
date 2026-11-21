import type { LiveCapture, Logger, ProviderSnapshot, RunningCaptures, Target } from "sdk";
import type { TsLiveApi } from "./api.js";
import type { TsLiveConfig } from "./config.js";
import type { TsLiveProvider } from "./provider.js";

// Who is live: one lookup of every listed account per poll. A listed account the site
// does not report live and public is offline (terminal); a stream reported without an ID
// is unidentified, which the core never captures. A new stream ID for an account replaces
// its running capture.
export class TsLiveCapture implements LiveCapture {
    public readonly pollIntervalMs: number;
    public readonly replaceSessionOnNewRecording = true;
    public readonly mediaFormat = "ts" as const;

    constructor(private readonly api: TsLiveApi, public readonly provider: TsLiveProvider, config: TsLiveConfig, private readonly log: Logger) {
        this.pollIntervalMs = config.pollIntervalMs;
    }

    public async lookup(targets: Target[], _running: RunningCaptures): Promise<ProviderSnapshot | null> {
        const ids = targets.map((target) => target.id).filter(Boolean);
        if (ids.length === 0) return null;
        const result = await this.api.liveByAccountIds(ids);
        if (!result) {
            this.log.verbose("Poll complete: the live lookup could not be read.");
            return null;
        }
        this.provider.noteLookup(result.live);
        const labels = new Map(targets.map((target) => [target.id, target.label]));
        const identified = [...result.live.values()].filter((stream) => stream.streamId !== "");
        return {
            observedAt: Date.now(),
            live: new Map(identified.map((stream) => [stream.accountId, {
                targetId: stream.accountId,
                alias: labels.get(stream.accountId) ?? stream.accountId,
                recordingId: stream.streamId,
                masterPlaylistUrl: stream.masterUrl,
            }])),
            terminalTargetIds: new Set(ids.filter((id) => !result.live.has(id))),
            unidentifiedTargetIds: new Set([...result.live.values()].filter((stream) => stream.streamId === "").map((stream) => stream.accountId)),
        };
    }

    // A recording folder is named after the account's label in the list.
    public targetIdForFolderAlias(alias: string, targets: readonly Target[]): string | null {
        return targets.find((target) => target.label === alias)?.id ?? null;
    }
}
