import { SDK_VERSION, type PluginContext, type SiteInstance, type SitePlugin } from "sdk";
import { TsLiveApi } from "./api.js";
import { TsLiveAuth } from "./auth.js";
import { TsLiveCapture } from "./capture.js";
import { TsLiveCatalog } from "./catalog.js";
import { readConfig } from "./config.js";
import { TsLiveProvider } from "./provider.js";
import { tokenReader } from "./tokens.js";

// A live site with account-gated HLS over MPEG-TS. The auth daemon keeps the account
// signed in (a rotating refresh token, an hour's session token, ten-second stream tokens)
// and saves the session to the core's credential store; capture and catalog read it from
// there on every request. Discovery asks the site who is live among the listed accounts;
// the best variant of each live stream is captured. The site's address and timings come
// from the sites file (config.ts).
export const plugin: SitePlugin = {
    id: "ts-live",
    label: "Wimbledon",
    sdkVersion: SDK_VERSION,
    create(context: PluginContext): SiteInstance {
        const config = readConfig(context.config);
        const tokens = tokenReader(context.credentials);
        const api = new TsLiveApi(config, tokens, context.log);
        const provider = new TsLiveProvider(context.siteId, tokens, config, context.log);
        return {
            catalog: new TsLiveCatalog(api, config, context.aliases),
            capture: new TsLiveCapture(api, provider, config, context.log),
            auth: new TsLiveAuth(config, context.authLog ?? context.log, context.clock),
        };
    },
};

export default plugin;

export { TsLiveApi, LOOKUP_BATCH, PROFILE_BATCH } from "./api.js";
export type { LiveLookup, LiveStream, Profile } from "./api.js";
export { TsLiveAuth, SignInRefused, SessionRejected, ChallengeRequired } from "./auth.js";
export { TsLiveCapture } from "./capture.js";
export { TsLiveCatalog } from "./catalog.js";
export { readConfig, DEFAULTS } from "./config.js";
export type { TsLiveConfig } from "./config.js";
export { TsLiveProvider, parseVariants } from "./provider.js";
export { bagOf, claimsOf, cookieValue, headersForTokens, recordOf, tokenReader, tokensFromCredentials } from "./tokens.js";
export type { Tokens, TsLiveRecord } from "./tokens.js";
