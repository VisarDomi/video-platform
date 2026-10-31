import { BUNKR_SERVER } from "../core/config";

browser.runtime.onMessage.addListener((raw, sender) => {
    const message = raw as { action?: string; url?: string; id?: string };
    try {
        const source = new URL(sender?.url ?? "");
        if (source.protocol !== "https:" || !/^bunkr\.(si|ph|cr)$/.test(source.hostname)) return undefined;
    } catch { return undefined; }
    if (message.action === "health") return request("/health");
    if (message.action === "status" && /^[a-f0-9]{24}$/.test(message.id ?? "")) return request(`/downloads/${message.id}`);
    if (message.action === "download" || message.action === "lookup") {
        try {
            const url = new URL(message.url ?? "");
            if (url.protocol !== "https:" || !/^bunkr\.(si|ph|cr)$/.test(url.hostname) || !/^\/f\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) return undefined;
            if (message.action === "lookup") return lookup(url.pathname.replace(/\/$/, ""));
            return request("/downloads", { method: "POST", headers: { "Content-Type": "application/json", "X-Video-Download": "1" }, body: JSON.stringify({ url: url.href }) });
        } catch { return undefined; }
    }
    return undefined;
});
async function lookup(path: string) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    const id = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 24);
    return request(`/downloads/${id}`);
}
async function request(path: string, init: RequestInit = {}) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), init.method === "POST" ? 10_000 : 5000);
        try {
            const response = await fetch(`${BUNKR_SERVER}/api/bunkr${path}`, { ...init, cache: "no-store", signal: controller.signal });
            const body = await response.json();
            return path === "/health" ? { ok: response.ok && body.service === "video-platform-bunkr", status: response.status } : { ok: response.ok, status: response.status, job: body };
        } finally { clearTimeout(timeout); }
    } catch { return { ok: false, status: 0 }; }
}
