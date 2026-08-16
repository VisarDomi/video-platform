import { ChromiumXvideosUploader } from "./dist/upload/chromiumXvideosUploader.js";
import { readXvideosCredentials } from "./dist/config/secrets.js";

const creds = await readXvideosCredentials("/home/visar/Documents/work/video/video-platform/packages/.env");
const uploader = new ChromiumXvideosUploader({
    executablePath: "/usr/bin/chromium",
    profilePath: "/home/visar/.config/chromium-agent",
    ...creds,
});
const entry = await uploader.findExistingByMatchKey("[2026-08-03 163201 AI_channel]");
console.log(JSON.stringify({ guardCheck: entry ? "found" : "none", entry }));
