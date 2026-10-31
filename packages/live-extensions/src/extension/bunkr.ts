export {};
type Job = { id: string; state: "queued" | "downloading" | "complete" | "failed"; bytes: number; total?: number };
const hosts = new Set(["bunkr.si", "bunkr.ph", "bunkr.cr"]);
const labels = new Map<HTMLAnchorElement, string>();
const submissions = new Set<string>();
let pageKey = "", known: Job | undefined, reachable = false, checkedAt = 0, uncertain = false;
let timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | undefined, refreshAgain = false;

function filePage() { return /^\/f\/[a-zA-Z0-9]+\/?$/.test(location.pathname) ? location.pathname.replace(/\/$/, "") : ""; }
function job(value: unknown): Job | undefined {
    const j = value as Job | undefined;
    return j && /^[a-f0-9]{24}$/.test(j.id) && ["queued", "downloading", "complete", "failed"].includes(j.state) &&
        Number.isFinite(j.bytes) && j.bytes >= 0 ? { id: j.id, state: j.state, bytes: j.bytes, total: j.total } : undefined;
}
function remember() {
    try {
        const key = `bunkr-to-pc:v1:${pageKey}`;
        if (known) sessionStorage.setItem(key, JSON.stringify(known)); else sessionStorage.removeItem(key);
    } catch { /* The server remains authoritative when Safari storage is unavailable. */ }
}
function changePage() {
    const key = filePage();
    if (key === pageKey) return;
    for (const [anchor, original] of labels) if (anchor.isConnected) anchor.textContent = original;
    labels.clear(); pageKey = key; known = undefined; reachable = false; checkedAt = 0; uncertain = false;
    try { known = job(JSON.parse(sessionStorage.getItem(`bunkr-to-pc:v1:${key}`) ?? "null")); } catch { /* Ignore an invalid cache. */ }
}
function downloadLink(target: EventTarget | null): HTMLAnchorElement | undefined {
    if (!(target instanceof Element) || !filePage()) return undefined;
    const anchor = target.closest<HTMLAnchorElement>("a[href]");
    if (!anchor) return undefined;
    try {
        const url = new URL(anchor.href);
        if (url.protocol === "https:" && /^dl\.bunkr\.(si|ph|cr)$/.test(url.hostname) && /^\/file\/\d+$/.test(url.pathname)) return anchor;
    } catch { /* Not a file download. */ }
    return undefined;
}
function paint() {
    let text: string | undefined;
    if (submissions.has(pageKey)) text = "Sending to PC…";
    else if (known?.state === "complete") text = "Downloaded to PC ✓";
    else if (known?.state === "failed") text = reachable ? "PC download failed · tap to retry" : "PC download failed · reconnecting…";
    else if (known) {
        text = known.state === "queued" ? "Queued on PC" : `Downloading to PC${known.total ? ` · ${Math.min(99, Math.floor(known.bytes / known.total * 100))}%` : "…"}`;
        if (!reachable) text += " · reconnecting…";
    } else if (uncertain) text = reachable ? "Could not confirm PC download · tap to retry" : "Checking PC download · reconnecting…";
    for (const [anchor, original] of labels) {
        if (!anchor.isConnected) { labels.delete(anchor); continue; }
        const label = text ?? original;
        if (anchor.textContent !== label) anchor.textContent = label;
        anchor.title = "Download to ~/Videos/plab/bunkr on the PC";
    }
}
function discover() {
    changePage();
    for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
        if (downloadLink(anchor) && !labels.has(anchor)) labels.set(anchor, anchor.textContent ?? "Download");
    }
    paint();
}
async function send(message: unknown): Promise<Record<string, unknown>> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        const deadline = (message as { action?: string }).action === "download" ? 12_000 : 7000;
        const reply = await Promise.race([browser.runtime.sendMessage(message), new Promise(resolve => {
            timeout = setTimeout(() => resolve({ ok: false, status: 0 }), deadline);
        })]);
        return reply && typeof reply === "object" ? reply as Record<string, unknown> : { ok: false };
    }
    catch { return { ok: false, status: 0 }; }
    finally { clearTimeout(timeout); }
}
function refresh(force = false): Promise<void> {
    clearTimeout(timer); changePage(); discover();
    if (running) { refreshAgain ||= force; return running; }
    const key = pageKey;
    if (!key) return Promise.resolve();
    running = (async () => {
        // Lookup is a read of the PC's deterministic page ID, never a second submission.
        const reply = await send(known ? { action: "status", id: known.id } : { action: "lookup", url: location.href });
        if (pageKey !== key) return;
        const current = job(reply.job);
        if (reply.ok === true && current) { known = current; uncertain = false; reachable = true; checkedAt = Date.now(); remember(); }
        else if (reply.status === 404) { known = undefined; reachable = true; checkedAt = Date.now(); remember(); }
        else reachable = false;
        discover();
    })().finally(() => {
        running = undefined;
        const delay = refreshAgain ? 0 : document.hidden || known?.state === "complete" ? 15_000 : reachable ? 3000 : 5000;
        refreshAgain = false; timer = setTimeout(() => void refresh(), delay);
    });
    return running;
}
if (hosts.has(location.hostname)) {
    discover(); void refresh();
    new MutationObserver(discover).observe(document.documentElement, { childList: true, subtree: true });
    for (const event of ["online", "pageshow", "focus"]) window.addEventListener(event, () => void refresh(true));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(true); });
    // Detect same-document navigation too; replies from a previous file cannot repaint this one.
    setInterval(() => { if (filePage() !== pageKey) void refresh(true); }, 1000);
    document.addEventListener("click", event => {
        changePage(); const anchor = downloadLink(event.target);
        if (!anchor || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!known && !submissions.has(pageKey) && (!reachable || Date.now() - checkedAt > 20_000)) { void refresh(true); return; }
        event.preventDefault(); event.stopImmediatePropagation();
        if (submissions.has(pageKey) || (known && known.state !== "failed")) { void refresh(true); return; }
        if (!reachable) { void refresh(true); return; }
        if (!labels.has(anchor)) labels.set(anchor, anchor.textContent ?? "Download");
        const key = pageKey, url = location.href; submissions.add(key); uncertain = false; paint();
        void send({ action: "download", url }).then(reply => {
            if (pageKey !== key) return;
            const accepted = job(reply.job);
            if (reply.ok === true && accepted) { known = accepted; reachable = true; checkedAt = Date.now(); remember(); }
            else uncertain = true;
        }).finally(() => {
            submissions.delete(key);
            if (pageKey === key) { paint(); void refresh(true); }
        });
    }, true);
}
