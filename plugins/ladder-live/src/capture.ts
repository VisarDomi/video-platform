import type { LiveCapture, Logger, ProviderLiveStream, ProviderSnapshot, RunningCaptures, Target } from "sdk";
import type { LadderApi } from "./api.js";
import type { LadderConfig } from "./config.js";
import type { LadderProvider } from "./provider.js";

// Who is live: the whole paged channel list, every pollIntervalMs from the start of one
// poll to the start of the next. A listed channel that is absent or paid is offline
// (terminal); the broadcast's started_at is the recording identity. The playlist needs
// a control-channel handshake, so it is resolved only for a capture about to start.
export class LadderCapture implements LiveCapture {
    public readonly pollIntervalMs: number;
    public readonly pollFromStart = true;
    public readonly pollErrorMessage = "Error reading the channel list";
    public readonly mediaFormat = "ts" as const;

    constructor(
        private readonly api: Pick<LadderApi, "liveChannels">,
        public readonly provider: LadderProvider,
        config: LadderConfig,
        private readonly log: Logger,
    ) {
        this.pollIntervalMs = config.pollIntervalMs;
    }

    public async lookup(targets: Target[], _running: RunningCaptures): Promise<ProviderSnapshot | null> {
        const listed = targets.filter((target) => target.id !== "");
        // Nothing to ask about: no request, and no snapshot for the core to reconcile.
        if (listed.length === 0) return null;
        const channels = await this.api.liveChannels();
        if (!channels) return null;
        this.provider.noteChannelList(channels);
        const snapshot: ProviderSnapshot = { observedAt: Date.now(), live: new Map(), terminalTargetIds: new Set() };
        for (const target of listed) {
            const channel = channels.get(target.id);
            if (channel && !channel.paid) {
                snapshot.live.set(target.id, { targetId: target.id, alias: target.label, recordingId: channel.startedAt, masterPlaylistUrl: "" });
            } else {
                snapshot.terminalTargetIds.add(target.id);
            }
        }
        return snapshot;
    }

    public async resolveMaster(live: ProviderLiveStream): Promise<ProviderLiveStream | null> {
        const url = await this.provider.openStream(live.targetId, live.recordingId);
        if (!url) {
            this.log.warn(`Channel ${live.alias} (${live.targetId}) is live but its stream could not be opened`);
            return null;
        }
        return { ...live, masterPlaylistUrl: url };
    }
}
