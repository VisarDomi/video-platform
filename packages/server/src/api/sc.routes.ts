import { createTxtListRoutes } from "./txt-list-routes.js";
import { SC_FILE_PATH } from "../core/config.js";

export default createTxtListRoutes({ provider: "sc", filePath: SC_FILE_PATH, urlPrefix: "https://stripchat.com/" });
