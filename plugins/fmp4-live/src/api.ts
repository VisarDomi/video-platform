import { normalizeRecordingId, requestSignal, type Logger } from "sdk";
import type { Fmp4Config } from "./config.js";

// The site's own API: bulk status, a channel's stream (name and edges) and name
// resolution.

export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
// The status API answers at most this many channels per request.
export const STATUS_BATCH_SIZE = 100;

export type ShowStatus = "public" | "private" | "group" | "off" | "unknown";

export interface ChannelStatus {
    id: string;
    name: string;
    status: ShowStatus;
    live: boolean;
    // The last status change, in the stored identity form: the recording identity.
    statusSince: string;
}

export interface StreamInfo {
    channelId: string;
    name: string;
    streamName: string | null;
    available: boolean;
    active: boolean;
    statusSince: string;
    edges: string[];
    masterUrls: Record<string, string>;
}

const STATUSES = new Set(["public", "private", "group", "off"]);

export class Fmp4Api {
    private statusFailures = 0;

    constructor(private readonly config: Fmp4Config, private readonly log: Logger) {}

    public get headers(): Record<string, string> {
        return { "User-Agent": USER_AGENT };
    }

    private async getJson(path: string, timeoutMs = this.config.requestTimeoutMs): Promise<{ status: number; body: any }> {
        const response = await fetch(this.config.baseUrl + path, { headers: this.headers, signal: requestSignal(timeoutMs) });
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            return { status: response.status, body: null };
        }
        return { status: response.status, body: await response.json() };
    }

    // The status of every listed channel, in the order the site answered; null when the
    // site could not answer (never "all offline").
    public async statuses(ids: readonly string[]): Promise<Map<string, ChannelStatus> | null> {
        const result = new Map<string, ChannelStatus>();
        for (let i = 0; i < ids.length; i += STATUS_BATCH_SIZE) {
            const batch = ids.slice(i, i + STATUS_BATCH_SIZE);
            let body: any = null;
            let failure = "";
            try {
                const answer = await this.getJson(`/api/channels/status?ids=${batch.map(encodeURIComponent).join(",")}`);
                body = answer.body;
                if (answer.status !== 200) failure = `status ${answer.status}`;
            } catch (error: any) {
                failure = error?.message ?? "network error";
            }
            if (!Array.isArray(body?.channels)) {
                // One line per outage, not per poll.
                if (this.statusFailures++ === 0) {
                    this.log.warn(`Bulk status check failed for ${batch.length} channels (${failure || "no channels array"}); provider state unavailable`);
                }
                return null;
            }
            for (const raw of body.channels) {
                const id = String(raw?.id ?? "");
                if (!/^\d+$/.test(id)) continue;
                const status = typeof raw?.status === "string" && STATUSES.has(raw.status) ? raw.status as ShowStatus : "unknown";
                const since = typeof raw?.statusSince === "string" ? raw.statusSince : "";
                result.set(id, {
                    id,
                    name: typeof raw?.name === "string" && raw.name ? raw.name : id,
                    status,
                    live: raw?.live === true,
                    statusSince: since ? normalizeRecordingId(since) : "",
                });
            }
        }
        if (this.statusFailures > 0) {
            this.log.info(`Bulk status check recovered after ${this.statusFailures} failures`);
            this.statusFailures = 0;
        }
        return result;
    }

    // A channel's current stream; null when the site has no such channel. Throws when it
    // cannot say.
    public async stream(channelId: string, timeoutMs?: number): Promise<StreamInfo | null> {
        const { status, body } = await this.getJson(`/api/channels/${encodeURIComponent(channelId)}/stream`, timeoutMs);
        if (status === 404) return null;
        if (status !== 200 || typeof body?.stream !== "object" || body.stream === null) throw new Error(`stream API returned ${status}`);
        const stream = body.stream;
        const masterUrls: Record<string, string> = {};
        for (const [edge, url] of Object.entries(stream.masterUrls ?? {})) if (typeof url === "string") masterUrls[edge] = url;
        return {
            channelId: String(body.channel?.id ?? channelId),
            name: typeof body.channel?.name === "string" ? body.channel.name : channelId,
            streamName: typeof stream.name === "string" && stream.name ? stream.name : null,
            available: stream.available === true,
            active: stream.active === true,
            statusSince: typeof stream.statusSince === "string" ? normalizeRecordingId(stream.statusSince) : "",
            edges: Array.isArray(stream.edges) ? stream.edges.map(String) : Object.keys(masterUrls),
            masterUrls,
        };
    }

    // A channel by any name it has had: {id, current name}; null when nobody has the
    // name. Throws when the site cannot say.
    public async byName(name: string): Promise<{ id: string; name: string } | null> {
        const { status, body } = await this.getJson(`/api/channels/by-name/${encodeURIComponent(name)}`);
        if (status === 404) return null;
        if (status !== 200 || body?.id === undefined) throw new Error(`name lookup returned ${status}`);
        return { id: String(body.id), name: String(body.name ?? name) };
    }
}
