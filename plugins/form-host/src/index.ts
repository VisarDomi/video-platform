import { SDK_VERSION, type Destination, type DestinationHost, type DestinationPlugin } from "sdk";
import { FormHostDestination, readConfig } from "./destination.js";
import { adoptSession, companionDestination, readSession } from "./shared.js";

// form-host: a browser-style upload destination (the simulator's), spoken over HTTP with
// the same forms its pages post: a cookie session with remember-me, a chunked file
// transfer, a metadata form that creates the video, a paged uploads list and the edit
// and video pages that verify it.
export const destination: DestinationPlugin = {
    id: "form-host",
    sdkVersion: SDK_VERSION,
    creationBoundary: "metadata_submit",
    // The simulated host's limits: 10 GiB a file, no duration limits (its processing rules
    // may still fail a video), public uploads.
    policy: { minimumDurationSeconds: null, maximumDurationSeconds: null, maximumFileBytes: 10 * 1024 ** 3, uploadVisibility: "public" },
    createDestination(host: DestinationHost): Destination {
        return new FormHostDestination(readConfig(host.config), host);
    },
    // The session cookie (and the consent cookie) of the destination's jar, never the
    // remember-me token: a companion uses exactly this session and never signs in.
    readSharedSession: (_config, stateDir) => readSession(stateDir),
    createCompanionDestination: (host, session, onSessionChange) => companionDestination(host, session, onSessionChange),
    adoptSharedSession: (_config, session, stateDir) => adoptSession(session, stateDir),
};

export default destination;
export { FormHostDestination, readConfig, type FormHostConfig } from "./destination.js";
export { FormHostClient } from "./client.js";
export * as pages from "./pages.js";
