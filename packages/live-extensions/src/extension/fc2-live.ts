import { mountDownloadListBar } from "../core/downloadListBar";
import { fc2Live } from "../provider/fc2-live";
import { autoClickFc2Login } from "../provider/fc2Login";

mountDownloadListBar(fc2Live);
autoClickFc2Login();
