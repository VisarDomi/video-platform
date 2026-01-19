import logger from "../../common/logger.js";
import { IStreamProvider } from "../core/interfaces.js";

export class StreamQualityMonitor {
    private provider: IStreamProvider;
    private masterUrl: string;
    private currentLiveUrl: string;
    private intervalMs: number;
    private timer: NodeJS.Timeout | null = null;
    private onQualityChange: (newUrl: string) => void;
    private isPolling = false;

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
        this.intervalMs = intervalMs;
    }

    public start(): void {
        if (this.timer) return;

        this.timer = setInterval(async () => {
            if (this.isPolling) return;
            this.isPolling = true;

            try {
                const betterUrl = await this.provider.pollCurrentVariant(this.masterUrl, this.currentLiveUrl);
                if (betterUrl && betterUrl !== this.currentLiveUrl) {
                    logger.info(`[QualityMonitor] Quality change detected. \nOld: ${this.currentLiveUrl}\nNew: ${betterUrl}`);
                    this.currentLiveUrl = betterUrl;
                    this.onQualityChange(betterUrl);
                }
            } catch (error) {
                logger.error(`[QualityMonitor] Error polling variant`, { error: (error as Error).message });
            } finally {
                this.isPolling = false;
            }
        }, this.intervalMs);
    }

    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    public updateCurrentUrl(url: string) {
        this.currentLiveUrl = url;
    }
}