import { SERVER } from "../core/config";
import type { ListReply, ListRequest } from "../core/messages";

// Only this extension's own list, and only list/add/remove.
browser.runtime.onMessage.addListener(raw => {
    const message = raw as ListRequest;
    if (message?.action === "list") return reply(fetch(`${SERVER}${__API_PATH__}/list`), true);
    if ((message?.action === "add" || message?.action === "remove") && typeof message.identifier === "string" && message.identifier) {
        return reply(fetch(`${SERVER}${__API_PATH__}/${message.action}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: message.identifier }),
        }), false);
    }
    return undefined;
});

async function reply(request: Promise<Response>, list: boolean): Promise<ListReply> {
    try {
        const response = await request;
        if (!list) return { ok: response.ok, status: response.status };
        const body = await response.json() as unknown;
        const valid = Array.isArray(body) && body.every(item => typeof item === "string");
        return { ok: response.ok && valid, status: response.status, list: valid ? body as string[] : undefined };
    } catch (error) {
        console.error("Download list request failed", error);
        return { ok: false, status: 0 };
    }
}
