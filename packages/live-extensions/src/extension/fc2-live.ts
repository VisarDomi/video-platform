import { mountDownloadListBar } from "../core/downloadListBar";
import { fc2Live } from "../provider/fc2-live";
import { autoClickFc2Login } from "../provider/fc2Login";

autoClickFc2Login();

// Login watches the parser from document_start; only the bar needs a complete body.
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountDownloadListBar(fc2Live), { once: true });
} else {
    mountDownloadListBar(fc2Live);
}
