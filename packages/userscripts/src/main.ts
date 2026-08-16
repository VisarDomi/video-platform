import { mountDownloadListBar } from "./core/downloadListBar";
import { fc2 } from "./provider/fc2";
import { sc } from "./provider/sc";

// One userscript bundle carries every provider; the host decides which
// adapter runs (the same provider pattern manga-reader uses).
const host = location.hostname;
if (host === "live.fc2.com" || host.endsWith(".fc2.com")) {
    mountDownloadListBar(fc2);
} else if (host === "stripchat.com" || host.endsWith(".stripchat.com")) {
    mountDownloadListBar(sc);
}
