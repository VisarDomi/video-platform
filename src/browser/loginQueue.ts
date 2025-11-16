import logger from "../common/logger.js";
import * as types from "../common/types.js";
import { extractTokens } from "./playwrightLogin.js";

interface QueuedLogin {
    account: types.Account;
    resolve: (value: types.LoginResult) => void;
    reject: (reason?: any) => void;
}

class LoginQueue {
    private queue: QueuedLogin[] = [];
    private isProcessing = false;

    public add(account: types.Account): Promise<types.LoginResult> {
        return new Promise<types.LoginResult>((resolve, reject) => {
            this.queue.push({ account, resolve, reject });
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
            const result = await extractTokens(request.account);
            request.resolve(result);
        } catch (error) {
            request.reject(error);
        } finally {
            void this.processQueue();
        }
    }
}

export const loginQueue = new LoginQueue();