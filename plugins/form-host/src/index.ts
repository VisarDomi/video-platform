import { SDK_VERSION, type Destination, type DestinationHost, type DestinationPlugin } from "sdk";
import { FormHostDestination, readConfig } from "./destination.js";

// form-host: a browser-style upload destination (the simulator's), spoken over HTTP with
// the same forms its pages post: a cookie session with remember-me, a chunked file
// transfer, a metadata form that creates the video, a paged uploads list and the edit
// and video pages that verify it.
export const destination: DestinationPlugin = {
    id: "form-host",
    sdkVersion: SDK_VERSION,
    createDestination(host: DestinationHost): Destination {
        return new FormHostDestination(readConfig(host.config), host);
    },
};

export default destination;
export { FormHostDestination, readConfig, type FormHostConfig } from "./destination.js";
export { FormHostClient } from "./client.js";
export * as pages from "./pages.js";
