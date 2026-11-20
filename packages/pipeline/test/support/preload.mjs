// Preloaded by the test script: every pipeline test runs with the public tennis content
// profile and the "video-host" test destination, on three live sites. The sites file is a
// temporary one, never the deployment's.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { profile } from "profile-tennis";
import { useContentProfile } from "../../dist/contentProfile.js";

const sitesFile = path.join(mkdtempSync(path.join(os.tmpdir(), "pipeline-test-sites-")), "sites.json");
writeFileSync(sitesFile, JSON.stringify({
    contentProfile: "profile-tennis",
    destinations: [{ id: "video-host", plugin: new URL("./videoHost.mjs", import.meta.url).href }],
    // The pipeline reads the sites' IDs; it never loads their plug-ins.
    sites: [{ id: "live-a", plugin: "plugin-ladder-live" }, { id: "live-b", plugin: "plugin-fmp4-live" }, { id: "live-c", plugin: "plugin-ts-live" }],
}));
process.env.VIDEO_SITES_FILE = sitesFile;
useContentProfile(profile.create());
