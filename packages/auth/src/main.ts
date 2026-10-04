import "dotenv/config";
import * as fs from "fs";

import { AuthService } from "./auth/authService.js";
import { Account } from "./providers/interfaces.js";
import { getProvider } from "./providers/registry.js";
import logger from "./common/logger.js";
import { getConfig } from "./common/config.js";

interface Credentials {
    accounts: (Omit<Account, "provider"> & { provider?: string })[];
}

function loadCredentials(): { accounts: Account[] } {
    const { accountsPath } = getConfig();
    const fileContent = fs.readFileSync(accountsPath, "utf-8");
    const credentials: Credentials = JSON.parse(fileContent);

    if (!credentials.accounts || !Array.isArray(credentials.accounts)) {
        throw new Error(`${accountsPath} is missing the 'accounts' array.`);
    }

    const accounts: Account[] = credentials.accounts.map((a) => ({
        email: a.email,
        password: a.password,
        provider: a.provider ?? "tango",
    }));

    return { accounts };
}

async function main() {
    const { accounts } = loadCredentials();

    if (accounts.length === 0) {
        logger.warn(`No accounts found in ${getConfig().accountsPath}. Exiting.`);
        return;
    }

    logger.info(`Found ${accounts.length} account(s). Initializing auth services...`);

    const authPromises = accounts.map(async (account) => {
        const provider = getProvider(account.provider);
        const authService = new AuthService(account, provider);
        await authService.initiateAuth();
        authService.startBackgroundJobs();
        return authService;
    });

    try {
        await Promise.all(authPromises);
        logger.info("All authentication services have been initialized and are running.");
    } catch (error) {
        logger.error("An unhandled error occurred during the initialization of one or more auth services.", { error });
    }
}

void main();
