import buttonsCss from "app/src/player/buttons.css";
import { DownloadListButton, type Membership } from "app/src/player/DownloadListButton";
import type { ListReply, ListRequest } from "./messages";

export interface DownloadListAdapter {
    // The streamer identifier shown on the current page, or null when the
    // current route is not a streamer page (the bar hides).
    identify(): string | null;
}

// One shared implementation for every provider: a fixed top bar with the viewer's +/- button
// (packages/app) for the server's download list. A shadow root keeps the viewer's button styles
// and the site's own styles apart.
export function mountDownloadListBar(adapter: DownloadListAdapter): void {
    const button = new DownloadListButton();
    let current: string | null = null;
    let bar: HTMLDivElement | null = null;

    function createBar(): HTMLDivElement {
        const host = document.createElement("div");
        host.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;";
        const style = document.createElement("style");
        style.textContent = `${buttonsCss}\n.bar{background:#222;padding:8px 16px;font-family:sans-serif;color:#fff;font-size:14px;}`;
        const row = document.createElement("div");
        row.className = "bar buttons";
        const label = document.createElement("span");
        label.textContent = "Download List:";
        row.append(label, button.element);
        host.attachShadow({ mode: "open" }).append(style, row);
        document.body.insertBefore(host, document.body.firstChild);
        // The page starts below the bar, whose height follows the button's state.
        new ResizeObserver(() => { document.body.style.marginTop = `${host.offsetHeight}px`; }).observe(host);
        return host;
    }

    function init(): void {
        const identifier = adapter.identify();
        if (identifier && identifier !== current) {
            current = identifier;
            bar ??= createBar();
            bar.style.display = "block";
            void button.show(membership(identifier));
        } else if (identifier && bar) {
            bar.style.display = "block";
        } else if (bar) {
            current = null;
            bar.style.display = "none";
        }
    }

    init();
    setInterval(init, 1000);
}

// The background page talks to the PC, so the site's own security policy never applies.
function membership(identifier: string): Membership {
    return {
        async isMember() {
            const { member } = await request({ action: "member", identifier });
            if (member === undefined) throw new Error("Download-list membership was not answered");
            return member;
        },
        async change(add) {
            await request({ action: add ? "add" : "remove", identifier });
        },
    };
}

async function request(message: ListRequest): Promise<ListReply> {
    const reply = await (browser.runtime.sendMessage(message) as Promise<ListReply>);
    if (!reply.ok) throw new Error(reply.error ?? `Download-list ${message.action} failed: ${reply.status}`);
    return reply;
}
