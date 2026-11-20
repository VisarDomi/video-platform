import { SDK_VERSION, type PluginContext, type SiteInstance, type SitePlugin } from "sdk";
import { Fmp4Api } from "./api.js";
import { Fmp4Capture } from "./capture.js";
import { Fmp4Catalog } from "./catalog.js";
import { readConfig } from "./config.js";
import { NameHistory } from "./names.js";
import { Fmp4Provider } from "./provider.js";

// A live site serving fMP4 from several CDN edges. Discovery is one bulk status check
// of the listed channels; a capture reads its stream's edges from the stream API, and
// the core fails over between edges with the plug-in's edge knowledge. Media playlists
// may be obfuscated (the keys come from the sites file), and damaged fragments are
// repaired on arrival. The site's address, keys and timings come from config.ts.
export const plugin: SitePlugin = {
    id: "fmp4-live",
    label: "Australian Open",
    sdkVersion: SDK_VERSION,
    create(context: PluginContext): SiteInstance {
        const config = readConfig(context.config);
        const api = new Fmp4Api(config, context.log);
        const names = new NameHistory(context.store, context.log);
        const provider = new Fmp4Provider(context.siteId, api, config, context.log);
        return {
            catalog: new Fmp4Catalog(api, config),
            capture: new Fmp4Capture(api, provider, names, config, context.log),
            init: () => names.load(),
        };
    },
};

export default plugin;

export { Fmp4Api } from "./api.js";
export type { ChannelStatus, StreamInfo } from "./api.js";
export { Fmp4Capture } from "./capture.js";
export { Fmp4Catalog } from "./catalog.js";
export { readConfig, DEFAULTS } from "./config.js";
export type { Fmp4Config } from "./config.js";
export { edgeOfUrl, onEdge, parseVariants, streamOfUrl, variantKeyOf } from "./edges.js";
export { fragmentDurationS } from "./fragment.js";
export { NameHistory } from "./names.js";
export { decodePlaylist, decodeToken, playlistKeyId } from "./playlistCipher.js";
export { Fmp4Provider } from "./provider.js";
