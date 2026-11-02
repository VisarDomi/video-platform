export type BunkrJob = { id: string; state: "queued" | "downloading" | "complete" | "failed"; bytes: number; total?: number };
export const bunkrHosts = new Set(["bunkr.si", "bunkr.ph", "bunkr.cr"]);

export function bunkrFileURL(value: string, base = location.href): URL | undefined {
    try {
        const url = new URL(value, base);
        if (url.protocol !== "https:" || url.port || url.username || url.password || !bunkrHosts.has(url.hostname)
            || !/^\/f\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) return undefined;
        url.pathname = url.pathname.replace(/\/$/, ""); url.search = ""; url.hash = "";
        return url;
    } catch { return undefined; }
}
function job(value: unknown): BunkrJob | undefined {
    const j = value as BunkrJob | undefined;
    return j && /^[a-f0-9]{24}$/.test(j.id) && ["queued", "downloading", "complete", "failed"].includes(j.state)
        && Number.isFinite(j.bytes) && j.bytes >= 0 ? { id: j.id, state: j.state, bytes: j.bytes, total: j.total } : undefined;
}
let requests = 0;
const waiting: (() => void)[] = [];
async function send(message: unknown): Promise<Record<string, unknown>> {
    await new Promise<void>(resolve => { if (requests < 3) { requests++; resolve(); } else waiting.push(resolve); });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadline = (message as { action?: string }).action === "download" ? 12_000 : 7000;
        const reply = await Promise.race([browser.runtime.sendMessage(message), new Promise(resolve => {
            timeout = setTimeout(() => resolve({ ok: false, status: 0 }), deadline);
        })]);
        return reply && typeof reply === "object" ? reply as Record<string, unknown> : { ok: false };
    } catch { return { ok: false, status: 0 }; }
    finally { clearTimeout(timeout); const next = waiting.shift(); if (next) next(); else requests--; }
}

// One file's existing PC handoff/status state, shared by /f and album rows.
// Durable acceptance/transfer belongs to the PC; browsing never enqueues.
export class BunkrDownload {
    private known?: BunkrJob;
    private reachable = false;
    private checkedAt = 0;
    private uncertain = false;
    private unavailable = false;
    private timer?: ReturnType<typeof setTimeout>;
    private running?: Promise<void>;
    private refreshAgain = false;
    private active = false;
    private disposed = false;
    private sending = false;
    private readonly key: string;
    constructor(readonly url: URL, private readonly changed: () => void, private readonly showUnavailable = false) {
        this.key = `bunkr-to-pc:v1:${url.pathname}`;
        try { this.known = job(JSON.parse(sessionStorage.getItem(this.key) ?? "null")); } catch { /* Ignore an invalid cache. */ }
    }
    get hasJob(): boolean { return this.known !== undefined; }
    get submitting(): boolean { return this.sending; }
    get ready(): boolean { return this.reachable && Date.now() - this.checkedAt <= 20_000; }
    get state(): string { return this.known?.state ?? (this.unavailable ? "offline" : "new"); }
    get label(): string | undefined {
        if (this.sending) return "Sending to PC…";
        if (this.known?.state === "complete") return "Downloaded to PC ✓";
        if (this.known?.state === "failed") return this.reachable ? "PC download failed · tap to retry" : "PC download failed · reconnecting…";
        if (this.known) {
            const progress = this.known.total ? ` · ${Math.min(99, Math.floor(this.known.bytes / this.known.total * 100))}%` : "…";
            let text = this.known.state === "queued" ? this.known.bytes ? `Resuming on PC${progress}` : "Queued on PC" : `Downloading to PC${progress}`;
            if (!this.reachable) text += " · reconnecting…";
            return text;
        }
        if (this.uncertain) return this.reachable ? "Could not confirm PC download · tap to retry" : "Checking PC download · reconnecting…";
        if (this.unavailable) return "PC unavailable · tap to retry";
        return undefined;
    }
    private remember(): void {
        try { if (this.known) sessionStorage.setItem(this.key, JSON.stringify(this.known)); else sessionStorage.removeItem(this.key); }
        catch { /* The PC remains authoritative. */ }
    }
    resume(): void { if (!this.disposed) { this.active = true; void this.refresh(true); } }
    suspend(): void { this.active = false; clearTimeout(this.timer); }
    dispose(): void { this.disposed = true; this.suspend(); }
    refresh(force = false): Promise<void> {
        clearTimeout(this.timer);
        if (this.disposed) return Promise.resolve();
        if (this.running) { this.refreshAgain ||= force; return this.running; }
        this.running = (async () => {
            const reply = await send(this.known ? { action: "status", id: this.known.id } : { action: "lookup", url: this.url.href });
            if (this.disposed) return;
            const current = job(reply.job);
            if (reply.ok === true && current) {
                this.known = current; this.uncertain = false; this.unavailable = false; this.reachable = true; this.checkedAt = Date.now(); this.remember();
            } else if (reply.status === 404) {
                this.known = undefined; this.reachable = true; this.unavailable = false; this.checkedAt = Date.now(); this.remember();
            } else { this.reachable = false; if (this.showUnavailable) this.unavailable = true; }
            this.changed();
        })().finally(() => {
            this.running = undefined;
            const delay = this.refreshAgain ? 0 : document.hidden || this.known?.state === "complete" ? 15_000 : this.reachable ? 3000 : 5000;
            this.refreshAgain = false;
            if (this.active && !this.disposed) this.timer = setTimeout(() => void this.refresh(), delay);
        });
        return this.running;
    }
    async activate(): Promise<void> {
        if (this.disposed || this.sending) return;
        if (this.known && this.known.state !== "failed") { await this.refresh(true); return; }
        if (!this.ready) await this.refresh(true);
        if (this.disposed || this.sending || (this.known && this.known.state !== "failed")) return;
        if (!this.reachable) { this.unavailable = true; this.changed(); return; }
        this.sending = true; this.uncertain = false; this.changed();
        try {
            const reply = await send({ action: "download", url: this.url.href });
            if (this.disposed) return;
            const accepted = job(reply.job);
            if (reply.ok === true && accepted) { this.known = accepted; this.reachable = true; this.checkedAt = Date.now(); this.remember(); }
            else this.uncertain = true;
        } finally {
            this.sending = false;
            if (!this.disposed) { this.changed(); void this.refresh(true); }
        }
    }
}
