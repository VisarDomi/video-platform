import { SDK_VERSION, type PluginContext, type SiteInstance, type SitePlugin } from "sdk";
import { LadderApi } from "./api.js";
import { LadderCapture } from "./capture.js";
import { LadderCatalog } from "./catalog.js";
import { readConfig } from "./config.js";
import { LadderProvider } from "./provider.js";

// A live site whose streams are handed out by a control-channel handshake, as a quality
// ladder of TS playlists. Discovery reads the paged channel list; the handshake gives a
// media playlist per mode, of which the best rung within the configured height is
// captured. The site's address and timings come from the sites file (config.ts).
export const plugin: SitePlugin = {
    id: "ladder-live",
    label: "Ladder Live",
    sdkVersion: SDK_VERSION,
    create(context: PluginContext): SiteInstance {
        const config = readConfig(context.config);
        const api = new LadderApi(config, context.log);
        const provider = new LadderProvider(context.siteId, api, config, context.log);
        return {
            catalog: new LadderCatalog(api, config),
            capture: new LadderCapture(api, provider, config, context.log),
        };
    },
};

export default plugin;

export { LadderApi } from "./api.js";
export type { LiveChannel, StreamOffer } from "./api.js";
export { LadderCapture } from "./capture.js";
export { LadderCatalog } from "./catalog.js";
export { readConfig, DEFAULTS } from "./config.js";
export type { LadderConfig, Latency } from "./config.js";
export { parseLadder, selectPlaylist, modeOfUrl, qualityOf, latencyOf } from "./ladder.js";
export { LadderProvider } from "./provider.js";
