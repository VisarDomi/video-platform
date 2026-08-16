import { SERVER } from "./config";

export interface DownloadListAdapter {
    readonly apiPath: string;
    // The streamer identifier shown on the current page, or null when the
    // current route is not a streamer page (the bar hides).
    identify(): string | null;
}

interface SimpleResponse {
    status: number;
    responseText: string;
}

// One shared implementation for every provider: a fixed top bar with a
// "+ Add / - Remove" toggle that drives the server's download list.
export function mountDownloadListBar(adapter: DownloadListAdapter): void {
    let inList = false;
    let current: string | null = null;
    let bar: HTMLDivElement | null = null;

    function request(method: "GET" | "POST", path: string, data?: unknown): Promise<SimpleResponse> {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: SERVER + path,
                headers: data ? { "Content-Type": "application/json" } : {},
                data: data ? JSON.stringify(data) : undefined,
                onload: (response) => resolve({
                    status: response.status,
                    responseText: response.responseText,
                }),
                onerror: (error) => reject(error),
            });
        });
    }

    function updateButton(): void {
        const btn = bar?.querySelector("button");
        if (!btn) return;
        if (inList) {
            btn.textContent = "- Remove";
            btn.style.backgroundColor = "#dc3545";
        } else {
            btn.textContent = "+ Add";
            btn.style.backgroundColor = "#28a745";
        }
    }

    async function checkList(identifier: string): Promise<void> {
        try {
            const res = await request("GET", `${adapter.apiPath}/list`);
            const list = JSON.parse(res.responseText) as unknown;
            inList = Array.isArray(list) && list.includes(identifier);
        } catch (error) {
            console.error("video-platform userscript: failed to check list", error);
            inList = false;
        }
        updateButton();
    }

    async function toggle(): Promise<void> {
        if (!current) return;
        const path = adapter.apiPath + (inList ? "/remove" : "/add");
        try {
            const res = await request("POST", path, { identifier: current });
            if (res.status >= 200 && res.status < 300) {
                inList = !inList;
                updateButton();
            }
        } catch (error) {
            console.error("video-platform userscript: toggle failed", error);
        }
    }

    function createBar(): HTMLDivElement {
        const barElement = document.createElement("div");
        barElement.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;background:#222;padding:8px 16px;display:flex;align-items:center;gap:12px;font-family:sans-serif;color:#fff;font-size:14px;";
        const label = document.createElement("span");
        label.textContent = "Download List:";
        const btn = document.createElement("button");
        btn.style.cssText = "border:none;color:#fff;padding:6px 16px;border-radius:4px;cursor:pointer;font-size:14px;font-weight:bold;";
        btn.addEventListener("click", () => void toggle());
        barElement.appendChild(label);
        barElement.appendChild(btn);
        document.body.insertBefore(barElement, document.body.firstChild);
        document.body.style.marginTop = "40px";
        updateButton();
        return barElement;
    }

    function init(): void {
        const identifier = adapter.identify();
        if (identifier && identifier !== current) {
            current = identifier;
            bar ??= createBar();
            bar.style.display = "flex";
            void checkList(identifier);
        } else if (identifier && bar) {
            bar.style.display = "flex";
        } else if (bar) {
            current = null;
            bar.style.display = "none";
        }
    }

    init();
    setInterval(init, 1000);
}
