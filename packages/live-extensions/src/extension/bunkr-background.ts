import { BUNKR_SERVER } from "../core/config";

browser.runtime.onMessage.addListener((raw, sender) => {
    const message = raw as { action?: string; url?: string; id?: string };
    try {
        const source = new URL(sender?.url ?? "");
        if (source.protocol !== "https:" || !/^bunkr\.(si|ph|cr)$/.test(source.hostname)) return undefined;
    } catch { return undefined; }
    if (message.action === "health") return request("/health");
    if (message.action === "status" && /^[a-f0-9]{24}$/.test(message.id ?? "")) return request(`/downloads/${message.id}`);
    if (message.action === "download") {
        try {
            const url = new URL(message.url ?? "");
            if (url.protocol !== "https:" || !/^bunkr\.(si|ph|cr)$/.test(url.hostname) || !/^\/f\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) return undefined;
            return request("/downloads", { method: "POST", headers: { "Content-Type": "application/json", "X-Video-Download": "1" }, body: JSON.stringify({ url: url.href }) });
        } catch { return undefined; }
    }
    return undefined;
});
async function request(path: string, init: RequestInit = {}) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
            const response = await fetch(`${BUNKR_SERVER}/api/bunkr${path}`, { ...init, cache: "no-store", signal: controller.signal });
            const body = await response.json();
            return path === "/health" ? { ok: response.ok && body.service === "video-platform-bunkr" } : { ok: response.ok, job: body };
        } finally { clearTimeout(timeout); }
    } catch { return { ok: false }; }
}
