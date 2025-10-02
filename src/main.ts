// src/main.ts
import "dotenv/config";

import logger from "./common/logger.js";
import { AuthService } from "./auth/authService.js";

async function main() {
    logger.info("--- Starting Tango Auth Service ---");
    const authService = new AuthService();
    await authService.initiateAuth();
    authService.startBackgroundJobs();
}

main();