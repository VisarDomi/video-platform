// Content scripts ask their extension's background page to talk to the PC, so the site's
// own security policy never applies to these requests.
export interface ListRequest { action: "member" | "add" | "remove"; identifier: string }
export interface ListReply { ok: boolean; status: number; member?: boolean; error?: string }
