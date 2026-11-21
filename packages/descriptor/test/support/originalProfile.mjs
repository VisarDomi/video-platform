// Preloaded by the test script: the descriptor tests run with a content profile's prompt, model
// and output bounds: the deployment's own (private/profiles/original) when it is checked out,
// otherwise the public tennis profile, so a clone of the public repository runs them too.
import { configureDescriptor } from "../../dist/config.js";

let module;
try {
    module = await import("profile-original");
} catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    module = await import("profile-tennis");
}
configureDescriptor(module.profile.create().descriptor);
