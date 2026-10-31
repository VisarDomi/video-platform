export {};
// Intercept only the actual file's download button, and only with a recently reachable PC.
const filePage = /^\/f\/[a-zA-Z0-9]+\/?$/;
const hosts = new Set(["bunkr.si", "bunkr.ph", "bunkr.cr"]);
let reachable = false;
let checking: Promise<void> | undefined;
let checkedAt = 0;
let busy = false;
let jobId: string | undefined;
const labels = new Map<HTMLAnchorElement, string>();

function button(target: EventTarget | null): HTMLAnchorElement | undefined {
    if (!(target instanceof Element) || !filePage.test(location.pathname)) return undefined;
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return undefined;
    try {
        const url = new URL(anchor.href);
        if (url.protocol === "https:" && /^dl\.bunkr\.(si|ph|cr)$/.test(url.hostname) && /^\/file\/\d+$/.test(url.pathname)) return anchor;
    } catch { /* Not a download link. */ }
    return undefined;
}
function label(text: string) {
    for (const anchor of labels.keys()) { anchor.textContent = text; anchor.title = "Download to ~/Videos/plab/bunkr on the PC"; }
}
async function send(message: unknown): Promise<Record<string, unknown>> {
    try { const reply = await browser.runtime.sendMessage(message); return reply && typeof reply === "object" ? reply as Record<string, unknown> : { ok: false }; }
    catch { return { ok: false }; }
}
function check(): Promise<void> {
    checking ??= send({ action: "health" }).then(reply => {
        reachable = reply.ok === true; checkedAt = Date.now();
    }).finally(() => { checking = undefined; });
    return checking;
}
async function status() {
    if (!jobId) return;
    const reply = await send({ action: "status", id: jobId });
    if (reply.ok !== true) { label("PC download queued · status unavailable"); setTimeout(() => void status(), 5000); return; }
    const job = reply.job as { state?: string; bytes?: number; total?: number; error?: string };
    if (job.state === "complete") { label("Downloaded to PC ✓"); busy = false; return; }
    if (job.state === "failed") { label("PC download failed · tap to retry"); busy = false; jobId = undefined; return; }
    label(job.state === "downloading" ? `Downloading to PC${job.total ? ` · ${Math.min(99, Math.floor((job.bytes ?? 0) / job.total * 100))}%` : "…"}` : "Queued on PC");
    setTimeout(() => void status(), 3000);
}
if (hosts.has(location.hostname)) {
    void check();
    setInterval(() => void check(), 15_000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
    document.addEventListener("click", event => {
        const anchor = button(event.target);
        if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        // An unreachable PC leaves the site's original navigation completely alone.
        if (!reachable || Date.now() - checkedAt > 20_000) { void check(); return; }
        event.preventDefault(); event.stopImmediatePropagation();
        if (busy || jobId) return;
        labels.set(anchor, anchor.textContent ?? "Download"); busy = true; label("Sending to PC…");
        void send({ action: "download", url: location.href }).then(reply => {
            const job = reply.job as { id?: string } | undefined;
            if (reply.ok !== true || !job?.id) {
                // A lost acknowledgement may already have queued it: retry the same idempotent request.
                label("Could not confirm PC download · tap to retry"); busy = false; return;
            }
            jobId = job.id; label("Queued on PC"); void status();
        });
    }, true);
}
