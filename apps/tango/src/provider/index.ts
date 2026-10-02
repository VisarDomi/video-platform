import providers from "./providers.json";
import { tango } from "./tango/provider";
import { xvideos } from "./xvideos/provider";
import type { Provider } from "./types";

export { Handler } from "./types";
export type { Provider, Route, Stream } from "./types";

export function selectProvider(hostname: string): Provider {
    if (providers.tango.hosts.includes(hostname)) return tango;
    if (providers.xvideos.hosts.includes(hostname)) return xvideos;
    throw new Error(`Unsupported provider host: ${hostname}`);
}
