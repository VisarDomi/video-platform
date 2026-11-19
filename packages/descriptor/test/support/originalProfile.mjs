// Preloaded by the test script: the descriptor tests run with the production content
// profile's prompt, model and output bounds.
import { profile } from "profile-original";
import { configureDescriptor } from "../../dist/config.js";

configureDescriptor(profile.create().descriptor);
