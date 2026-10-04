import { SERVER } from "../core/config";
import type { ListReply, ListRequest } from "../core/messages";

// Only this extension's own list, and only member/add/remove.
browser.runtime.onMessage.addListener(raw => {
    const message = raw as ListRequest;
    if (typeof message?.identifier !== "string" || !message.identifier) return undefined;
    if (message.action === "member") {
        return reply(fetch(`${SERVER}${__API_PATH__}/member?identifier=${encodeURIComponent(message.identifier)}`), true);
    }
    if (message.action === "add" || message.action === "remove") {
        return reply(fetch(`${SERVER}${__API_PATH__}/${message.action}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identifier: message.identifier }),
        }), false);
    }
    return undefined;
});

async function reply(request: Promise<Response>, member: boolean): Promise<ListReply> {
    try {
        const response = await request;
        if (!member) return { ok: response.ok, status: response.status };
        const body = await response.json() as { member?: unknown } | null;
        const valid = typeof body?.member === "boolean";
        return { ok: response.ok && valid, status: response.status, member: valid ? body!.member as boolean : undefined };
    } catch (error) {
        console.error("Download list request failed", error);
        return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
    }
}
