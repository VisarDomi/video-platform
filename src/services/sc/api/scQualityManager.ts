import { Page } from "playwright";
import logger from "../../../common/logger.js";

export class ScQualityManager {
    private page: Page;
    private intervalId: NodeJS.Timeout | null = null;
    private currentQuality: string | null = null;
    private readonly CHECK_INTERVAL = 10000;
    private readonly PRIORITIES = ['1080p60', '1080p', '720p60', '720p'];

    constructor(page: Page) {
        this.page = page;
    }

    public start(): void {
        if (this.intervalId) return;
        logger.info("[SC] QualityManager started.");

        // Initial check after a short delay to let stream settle
        setTimeout(() => this.checkAndSetQuality(), 5000);

        this.intervalId = setInterval(() => {
            void this.checkAndSetQuality();
        }, this.CHECK_INTERVAL);
    }

    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private async checkAndSetQuality(): Promise<void> {
        try {
            if (this.page.isClosed()) return;

            // 1. Find and Click Gear
            const gearBtn = this.page.locator('.player-resolution').first();
            if (!(await gearBtn.isVisible())) {
                return;
            }
            await gearBtn.click();

            // 2. Wait for Menu
            const menu = this.page.locator('.player-resolution-tooltip__resolutions');
            try {
                await menu.waitFor({ state: "visible", timeout: 2000 });
            } catch {
                // Menu didn't open or timed out, maybe button wasn't clickable
                return;
            }

            // 3. Scan Options
            const optionElements = await menu.locator('> *').all(); // Direct children
            const availableOptions: { text: string; element: any }[] = [];

            for (const el of optionElements) {
                const text = (await el.innerText()).trim();
                if (text) {
                    availableOptions.push({ text, element: el });
                }
            }

            // 4. Determine Best Quality
            let targetOption = null;
            for (const priority of this.PRIORITIES) {
                targetOption = availableOptions.find(opt => opt.text === priority);
                if (targetOption) break;
            }

            // 5. Act
            if (targetOption) {
                if (this.currentQuality !== targetOption.text) {
                    logger.info(`[SC] QualityManager: Switching from ${this.currentQuality || 'Auto'} to ${targetOption.text}`);
                    await targetOption.element.click();
                    this.currentQuality = targetOption.text;

                    // Wait a bit for buffering/stream reset logic in browser
                    // No need to close menu, clicking an option usually closes it
                } else {
                    // We are already on the best quality. Close the menu by clicking gear again.
                    // logger.debug(`[SC] QualityManager: Keeping ${this.currentQuality}.`);
                    await gearBtn.click();
                }
            } else {
                // No HD options found (e.g., only 480p/Auto). Close menu.
                await gearBtn.click();
            }

        } catch (error: any) {
            // Ignore errors (page closed, selector moved, etc) to prevent crashing the stream
            // logger.debug(`[SC] QualityManager check failed: ${error.message}`);
        }
    }
}