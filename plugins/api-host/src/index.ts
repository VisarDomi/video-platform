import { SDK_VERSION, type Destination, type DestinationHost, type DestinationPlugin } from "sdk";
import { readConfig } from "./config.js";
import { ApiHostDestination } from "./destination.js";

// api-host: an API-style upload destination (the simulator's): OAuth tokens with a
// rotating refresh token, resumable uploads that create the video first, a paged uploads
// list with a count, and the video resource that verifies it.
export const destination: DestinationPlugin = {
    id: "api-host",
    sdkVersion: SDK_VERSION,
    creationBoundary: "transfer_start",
    // The simulated host's limits: 128 GiB a file, no duration limits (its processing rules
    // may still fail a video), public uploads.
    policy: { minimumDurationSeconds: null, maximumDurationSeconds: null, maximumFileBytes: 128 * 1024 ** 3, uploadVisibility: "public" },
    createDestination(host: DestinationHost): Destination {
        return new ApiHostDestination(readConfig(host.config), host);
    },
};

export default destination;
export { ApiHostDestination, clientRefOf, type ApiVideo } from "./destination.js";
export { readConfig, type ApiHostConfig } from "./config.js";
export { Tokens } from "./tokens.js";
