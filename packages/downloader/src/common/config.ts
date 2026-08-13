import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SHARED_STATE_PATH = path.join(os.homedir(), ".local", "share", "video-services");

if (!fs.existsSync(SHARED_STATE_PATH)) {
    fs.mkdirSync(SHARED_STATE_PATH, { recursive: true });
}

export const config = {
    storagePath: process.env.VIDEO_DOWNLOADS_ROOT
        ?? path.join(os.homedir(), "Videos", "downloads"),
    sharedStatePath: SHARED_STATE_PATH,
} as const;
