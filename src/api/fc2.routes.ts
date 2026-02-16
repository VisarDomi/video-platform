import { createTxtListRoutes } from "./txt-list-routes.js";
import { FC2_FILE_PATH } from "../core/config.js";

export default createTxtListRoutes({ provider: "fc2", filePath: FC2_FILE_PATH, urlPrefix: "https://live.fc2.com/", urlSuffix: "/" });
