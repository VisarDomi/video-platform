import { createTxtListRoutes } from "./txt-list-routes.js";
import { TANGO_FILE_PATH } from "../core/config.js";

export default createTxtListRoutes({ provider: "tango-list", filePath: TANGO_FILE_PATH, urlPrefix: "" });
