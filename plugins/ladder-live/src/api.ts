import { requestSignal, type Logger } from "sdk";
import type { LadderConfig } from "./config.js";

// The site's own API: the paged channel list, the member lookup and the control channel
// that hands out each stream's playlists.

export const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
// A list longer than this many pages is not believed (a site bug or a loop).
const MAX_PAGES = 100;
// How long the control channel may take to hand out the playlists.
export const HANDSHAKE_TIMEOUT_MS = 15_000;
// One long-poll of the control channel.
const RECV_WAIT_MS = 5_000;

export interface LiveChannel {
    id: string;
    name: string;
    // The broadcast's start (epoch seconds): the recording identity.
    startedAt: string;
    paid: boolean;
}

export interface StreamOffer {
    master: string;
    playlists: Array<{ url: string; mode: number }>;
}

interface ControlMessage {
    index: number;
    message: { name?: string; id?: unknown; arguments?: Record<string, unknown> };
}

export class LadderApi {
    private messageId = 0;

    constructor(private readonly config: LadderConfig, private readonly log: Logger) {}

    public get headers(): Record<string, string> {
        return { "User-Agent": USER_AGENT, Origin: this.config.baseUrl, Referer: `${this.config.baseUrl}/` };
    }

    private fetch(url: string, init: RequestInit = {}, timeoutMs = this.config.requestTimeoutMs): Promise<Response> {
        return fetch(url, { ...init, headers: { ...this.headers, ...(init.headers ?? {}) }, signal: requestSignal(timeoutMs, init.signal ?? undefined) });
    }

    private postForm(path: string, fields: Record<string, string>): Promise<Response> {
        return this.fetch(this.config.baseUrl + path, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields).toString(),
        });
    }

    // Every live channel, from every page of the list; null when the site could not
    // answer (never "nobody is live"). An empty channel array is the site's own
    // "nobody is live".
    public async liveChannels(): Promise<Map<string, LiveChannel> | null> {
        const channels = new Map<string, LiveChannel>();
        let pageCount = 1;
        for (let page = 1; page <= pageCount; page++) {
            if (page > MAX_PAGES) {
                this.log.warn(`Channel list claims ${pageCount} pages; provider state unavailable`);
                return null;
            }
            let body: any;
            try {
                const response = await this.fetch(`${this.config.baseUrl}/api/channels?page=${page}`);
                if (!response.ok) {
                    this.log.warn(`Channel list page ${page} returned ${response.status}`);
                    return null;
                }
                body = await response.json();
            } catch (error: any) {
                this.log.warn(`Channel list page ${page} unavailable`, { error: error?.message });
                return null;
            }
            if (!Array.isArray(body?.channel)) {
                this.log.warn(`Channel list page ${page} has no channel array; provider state unavailable`);
                return null;
            }
            pageCount = Number.isSafeInteger(body.pageCount) ? body.pageCount : 1;
            for (const raw of body.channel) {
                const id = String(raw?.id ?? "");
                const startedAt = String(raw?.started_at ?? "");
                if (!/^\d+$/.test(id) || !/^\d+$/.test(startedAt)) continue;
                channels.set(id, { id, name: String(raw?.name ?? id), startedAt, paid: Number(raw?.paid ?? 0) !== 0 });
            }
        }
        return channels;
    }

    // The channel's profile, or null when the site has no such channel. Throws when the
    // site cannot say.
    public async member(channelId: string): Promise<{ id: string; name: string } | null> {
        const response = await this.postForm("/api/member", { channel_id: channelId });
        if (!response.ok) throw new Error(`member lookup returned ${response.status}`);
        const body: any = await response.json();
        const profile = body?.profile;
        if (!profile || typeof profile !== "object") throw new Error("member lookup has no profile object");
        if (profile.id === undefined) return null;
        return { id: String(profile.id), name: String(profile.name ?? profile.id) };
    }

    // The control-channel handshake: open a channel for the stream, wait for "ready",
    // ask for the stream's playlists and wait for the reply to that request (other
    // messages arrive in between). Null when the channel is offline, paid or the
    // handshake failed (logged).
    public async openStream(channelId: string): Promise<StreamOffer | null> {
        let opened: any;
        try {
            const response = await this.postForm("/api/control/open", { channel_id: channelId, mode: "play" });
            if (!response.ok) {
                this.log.warn(`Control channel for ${channelId} returned ${response.status}`);
                return null;
            }
            opened = await response.json();
        } catch (error: any) {
            this.log.warn(`Control channel for ${channelId} unavailable`, { error: error?.message });
            return null;
        }
        if (opened?.status !== 0 || typeof opened.url !== "string") {
            this.log.debug(`Control channel for ${channelId} refused: ${opened?.reason ?? opened?.status ?? "no reason"}`);
            return null;
        }
        const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
        const channel = new ControlChannel(opened.url, this.headers);
        try {
            if (!await channel.waitFor((m) => m.name === "ready", deadline)) {
                this.log.warn(`Control channel for ${channelId} never became ready`);
                return null;
            }
            const id = ++this.messageId;
            await channel.send({ name: "get_stream_info", id, arguments: {} });
            const reply = await channel.waitFor((m) => m.name === "reply" && m.id === id, deadline);
            const args = reply?.arguments;
            if (!args || args.status !== 0 || typeof args.master !== "string" || !Array.isArray(args.playlists)) {
                this.log.warn(`Control channel for ${channelId} gave no stream information`, { status: args?.status ?? null });
                return null;
            }
            const playlists = (args.playlists as any[])
                .filter((p) => typeof p?.url === "string" && Number.isSafeInteger(p?.mode))
                .map((p) => ({ url: p.url as string, mode: p.mode as number }));
            return { master: args.master, playlists };
        } catch (error: any) {
            this.log.warn(`Control channel handshake for ${channelId} failed`, { error: error?.message });
            return null;
        }
    }

    public async fetchText(url: string): Promise<{ status: number; text: string } | null> {
        try {
            const response = await this.fetch(url);
            return { status: response.status, text: response.ok ? await response.text() : "" };
        } catch {
            return null;
        }
    }
}

// The site's message channel over HTTP long-poll: GET <url>/recv?after=N&wait=ms,
// POST <url>/send. Messages are numbered; "closed" ends the channel.
class ControlChannel {
    private after = 0;

    constructor(private readonly url: string, private readonly headers: Record<string, string>) {}

    public async send(message: Record<string, unknown>): Promise<void> {
        const response = await fetch(`${this.url}/send`, {
            method: "POST",
            headers: { ...this.headers, "Content-Type": "application/json" },
            body: JSON.stringify(message),
            signal: requestSignal(RECV_WAIT_MS * 2),
        });
        if (!response.ok) throw new Error(`control send returned ${response.status}`);
    }

    // The first message (after those already read) matching the predicate; null when the
    // channel closes or the deadline passes.
    public async waitFor(predicate: (message: ControlMessage["message"]) => boolean, deadline: number): Promise<ControlMessage["message"] | null> {
        while (Date.now() < deadline) {
            const wait = Math.max(0, Math.min(RECV_WAIT_MS, deadline - Date.now()));
            const response = await fetch(`${this.url}/recv?after=${this.after}&wait=${wait}`, {
                headers: this.headers,
                signal: requestSignal(wait + RECV_WAIT_MS),
            });
            if (response.status === 410) return null;
            if (!response.ok) throw new Error(`control recv returned ${response.status}`);
            const body: any = await response.json();
            for (const entry of (Array.isArray(body?.messages) ? body.messages : []) as ControlMessage[]) {
                if (entry.index > this.after) this.after = entry.index;
                if (entry.message?.name === "closed") return null;
                if (predicate(entry.message)) return entry.message;
            }
        }
        return null;
    }
}
