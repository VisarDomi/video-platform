import logger from "../../common/logger.js";
import { IStreamProvider } from "../core/interfaces.js";

export class StreamQualityMonitor {
    private provider: IStreamProvider;
    private masterUrl: string;
    private currentLiveUrl: string;
    private initialIntervalMs: number;
    private currentIntervalMs: number;
    private maxIntervalMs = 300000;
    private timer: NodeJS.Timeout | null = null;
    private onQualityChange: (newUrl: string) => void;
    private stopped = false;

    constructor(
        provider: IStreamProvider,
        masterUrl: string,
        initialLiveUrl: string,
        onQualityChange: (newUrl: string) => void,
        intervalMs = 10000
    ) {
        this.provider = provider;
        this.masterUrl = masterUrl;
        this.currentLiveUrl = initialLiveUrl;
        this.onQualityChange = onQualityChange;
        this.initialIntervalMs = intervalMs;
        this.currentIntervalMs = intervalMs;
    }

    public start(): void {
        if (this.timer) return;
        this.stopped = false;
        this.scheduleNext();
    }

    private scheduleNext(): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => void this.poll(), this.currentIntervalMs);
    }

    private async poll(): Promise<void> {
        if (this.stopped) return;

        try {
            const betterUrl = await this.provider.pollCurrentVariant(this.masterUrl, this.currentLiveUrl);
            if (betterUrl && betterUrl !== this.currentLiveUrl) {
                logger.info(`[QualityMonitor] Quality change detected. \nOld: ${this.currentLiveUrl}\nNew: ${betterUrl}`);
                this.currentLiveUrl = betterUrl;
                this.onQualityChange(betterUrl);
                this.currentIntervalMs = this.initialIntervalMs;
            } else {
                this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxIntervalMs);
            }
        } catch (error) {
            logger.error(`[QualityMonitor] Error polling variant`, { error: (error as Error).message });
        }

        this.scheduleNext();
    }

    public stop(): void {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    public updateCurrentUrl(url: string) {
        this.currentLiveUrl = url;
    }
}