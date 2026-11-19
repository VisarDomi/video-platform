import type { SiteAuth, TokenBag } from "sdk";
import logger from "../common/logger.js";
import type { Account } from "../accounts.js";

// Browser sign-ins run one at a time across the daemon's accounts.
interface QueuedLogin {
    account: Account;
    provider: SiteAuth;
    resolve: (value: TokenBag) => void;
    reject: (reason?: any) => void;
}

class LoginQueue {
    private queue: QueuedLogin[] = [];
    private isProcessing = false;

    public add(account: Account, provider: SiteAuth): Promise<TokenBag> {
        return new Promise<TokenBag>((resolve, reject) => {
            this.queue.push({ account, provider, resolve, reject });
            logger.info(`Browser login for ${account.email} added to the queue. Queue size: ${this.queue.length}`);
            if (!this.isProcessing) {
                void this.processQueue();
            }
        });
    }

    private async processQueue(): Promise<void> {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            logger.info("Browser login queue is empty. Processor is going idle.");
            return;
        }

        this.isProcessing = true;
        const request = this.queue.shift();

        if (!request) {
            this.isProcessing = false;
            return;
        }

        logger.info(`Processing browser login for ${request.account.email}. Remaining in queue: ${this.queue.length}`);

        try {
            const result = await request.provider.login(request.account);
            request.resolve(result);
        } catch (error) {
            request.reject(error);
        } finally {
            void this.processQueue();
        }
    }
}

export const loginQueue = new LoginQueue();
