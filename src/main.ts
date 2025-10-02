// src/main.ts
import "dotenv/config";

import { AuthService } from "./auth/authService.js";

async function main() {
    const authService = new AuthService();
    await authService.initiateAuth();
    authService.startBackgroundJobs();
}

main();