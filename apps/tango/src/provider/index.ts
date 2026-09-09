import { tango } from "./tango/provider";
import { xvideos } from "./xvideos/provider";
import type { Provider } from "./types";

export { Handler } from "./types";
export type { Provider, Route, Stream } from "./types";

export function selectProvider(hostname: string): Provider {
    if (hostname === "tango.me" || hostname === "www.tango.me") return tango;
    if (hostname === "xvideos.com" || hostname === "www.xvideos.com") return xvideos;
    throw new Error(`Unsupported provider host: ${hostname}`);
}
