import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";

const REQUEST_DELAY_MS = 1000;

interface QueuedRequest<T> {
    url: string;
    options: RequestInit;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
    responseType: "json" | "text" | "raw";
}

class RequestQueue {
    private queue: QueuedRequest<any>[] = [];
    private isProcessing = false;
    public add<T>(url: string, options: RequestInit, responseType: "json" | "text" | "raw" = "json"): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ url, options, resolve, reject, responseType });
            logger.verbose(`Request for ${url} added to the queue. Queue size: ${this.queue.length}`);
            
            if (!this.isProcessing) {
                void this._processQueue();
            }
        });
    }

    private async _processQueue(): Promise<void> {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            logger.verbose("Request queue is empty. Processor is going idle.");
            return;
        }

        this.isProcessing = true;
        const request = this.queue.shift();

        if (!request) {
            this.isProcessing = false;
            return; 
        }

        logger.verbose(`Processing request for ${request.url}. Remaining in queue: ${this.queue.length}`);

        try {
            const response = await fetch(request.url, request.options);
            
            request.resolve(response);

        } catch (error) {
            request.reject(error);
        } finally {
            await timersPromises.setTimeout(REQUEST_DELAY_MS);
            void this._processQueue();
        }
    }
}

export const requestQueue = new RequestQueue();