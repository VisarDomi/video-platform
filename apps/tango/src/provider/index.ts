import { tango } from "./tango/provider";
import type { Provider } from "./types";

export { Handler } from "./types";
export type { Provider, Route, Stream } from "./types";

export function selectProvider(hostname: string): Provider {
    if (hostname === "tango.me" || hostname === "www.tango.me") return tango;
    throw new Error(`Unsupported provider host: ${hostname}`);
}
