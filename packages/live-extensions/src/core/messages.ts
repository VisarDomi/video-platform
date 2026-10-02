// Content scripts ask their extension's background page to talk to the PC, so the site's
// own security policy never applies to these requests.
export type ListRequest = { action: "list" } | { action: "add" | "remove"; identifier: string };
export interface ListReply { ok: boolean; status: number; list?: string[] }
