// src/services/queue.service.ts
import logger from '../logger.js';

/**
 * @fileoverview
 * A generic, in-memory job queue that processes tasks sequentially.
 * This ensures that resource-intensive tasks (like video encoding) are executed
 * one at a time, preventing system overload. It is designed to be "fire-and-forget."
 */

// Defines the shape of a function that can process a job.
type JobWorker<T> = (job: T) => Promise<void>;

export class JobQueue<T> {
    private queue: T[] = [];
    private isProcessing = false;
    private worker: JobWorker<T>;

    /**
     * Creates an instance of a JobQueue.
     * @param worker An async function that takes a job payload and processes it.
     */
    constructor(worker: JobWorker<T>) {
        this.worker = worker;
    }

    /**
     * Adds a new job to the queue and starts processing if not already active.
     * @param job The job payload to add to the queue.
     */
    public add(job: T): void {
        this.queue.push(job);
        logger.info(`Job added to queue. Current queue size: ${this.queue.length}`);
        // The 'void' operator indicates we are intentionally not awaiting the promise here.
        void this.process();
    }

    /**
     * Processes jobs from the queue one by one until it's empty.
     * This method is self-contained and should not be called from outside the class.
     */
    private async process(): Promise<void> {
        if (this.isProcessing) {
            return;
        }

        this.isProcessing = true;
        logger.info(`Starting queue processing. Jobs to process: ${this.queue.length}`);

        while (this.queue.length > 0) {
            const job = this.queue.shift(); // Get the next job from the front
            if (job) {
                try {
                    await this.worker(job);
                } catch (error) {
                    // Log the error but continue processing the rest of the queue
                    logger.error(`A job in the queue failed to process:`, { job, error });
                }
            }
        }

        this.isProcessing = false;
        logger.info('Queue processing finished.');
    }
}
