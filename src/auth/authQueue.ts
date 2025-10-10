// src/common/authQueue.ts
import * as timersPromises from "timers/promises";

import logger from "../common/logger.js";

const REQUEST_DELAY_MS = 1000; // The delay between each request in milliseconds.

interface QueuedRequest<T> {
    url: string;
    options: RequestInit;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
    responseType: "json" | "text" | "raw"; // Add responseType to handle different fetch responses
}

class RequestQueue {
    private queue: QueuedRequest<any>[] = [];
    private isProcessing = false;

    /**
     * Adds a fetch request to the queue.
     * Returns a promise that resolves or rejects when the request is finally processed.
     */
    public add<T>(url: string, options: RequestInit, responseType: "json" | "text" | "raw" = "json"): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ url, options, resolve, reject, responseType });
            logger.verbose(`Request for ${url} added to the queue. Queue size: ${this.queue.length}`);
            
            // If the queue isn't currently being processed, start it.
            if (!this.isProcessing) {
                this._processQueue();
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
        const request = this.queue.shift(); // Get the next request

        if (!request) {
            // Should not happen if length > 0, but it's good practice
            this.isProcessing = false;
            return; 
        }

        logger.verbose(`Processing request for ${request.url}. Remaining in queue: ${this.queue.length}`);

        try {
            const response = await fetch(request.url, request.options);
            
            // Unlike a simple `response.ok` check, we need to pass the full response
            // to the original caller, as they might need to inspect headers (like set-cookie).
            // So we'll let the original client logic handle the response object.
            
            // The original logic needs the response object to check headers etc.
            request.resolve(response);

        } catch (error) {
            request.reject(error);
        } finally {
            // Wait for the specified delay before processing the next item.
            await timersPromises.setTimeout(REQUEST_DELAY_MS);
            this._processQueue(); // Process the next item
        }
    }
}

// Export a single instance (singleton pattern) to be used across the application.
export const requestQueue = new RequestQueue();