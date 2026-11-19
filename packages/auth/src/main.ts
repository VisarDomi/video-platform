import "dotenv/config";

import { CredentialStore, loadSiteRegistry, type HostedSite } from "shared";
import { AuthService } from "./auth/authService.js";
import { loadAccounts } from "./accounts.js";
import logger from "./common/logger.js";
import { getConfig } from "./common/config.js";

// The auth daemon: keeps every configured account signed in on its site. The sites come
// from the sites file (those whose plug-in has auth), the accounts and their passwords
// from the accounts file; each account's session is saved to the core's credential
// store, where the site's consumers (downloader, server) read it.
async function main() {
    const sites = (await loadSiteRegistry({ logger })).filter((site) => site.instance.auth);
    const accounts = loadAccounts(getConfig().accountsPath, sites[0]?.id);

    if (accounts.length === 0) {
        logger.warn(`No accounts found in ${getConfig().accountsPath}. Exiting.`);
        return;
    }

    logger.info(`Found ${accounts.length} account(s). Initializing auth services...`);
    warnAboutUnrefreshedSessions(sites, accounts.map((account) => ({ site: account.provider, email: account.email })));

    const store = new CredentialStore(getConfig().sessionPath);
    const authPromises = accounts.map(async (account) => {
        const site = sites.find((candidate) => candidate.id === account.provider);
        if (!site) {
            throw new Error(`Unknown auth provider: "${account.provider}". Available: ${sites.map((candidate) => candidate.id).join(", ")}`);
        }
        const authService = new AuthService(account, site.instance.auth!, { label: site.label, log: site.context.log, store });
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

// A site's consumers read the session of the account the sites file names; nothing would
// renew it if no configured account is that one.
function warnAboutUnrefreshedSessions(sites: HostedSite[], kept: { site: string; email: string }[]): void {
    for (const site of sites) {
        const account = site.entry.account;
        if (account && !kept.some((entry) => entry.site === site.id && entry.email === account)) {
            logger.warn(`Site ${site.id}: its consumers read the session of ${account}, which no configured account keeps signed in`);
        }
    }
}

void main().catch((error) => {
    logger.error("The auth daemon could not start", { error });
    process.exit(1);
});
