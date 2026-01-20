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

        // Initial check
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

            // 1. Simulate Hover to reveal UI
            // The controls are hidden by CSS until mouse interaction
            const videoEl = this.page.locator('video').first();
            if (await videoEl.isVisible()) {
                await videoEl.hover();
                // Short wait for CSS fade-in
                await this.page.waitForTimeout(500);
            } else {
                return;
            }

            // 2. Find Gear Button
            const gearBtn = this.page.locator('.player-resolution').first();
            if (!(await gearBtn.isVisible())) {
                // UI didn't appear or selector is wrong
                return;
            }

            // 3. Click Gear
            await gearBtn.click();

            // 4. Wait for Menu
            const menu = this.page.locator('.player-resolution-tooltip__resolutions');
            try {
                await menu.waitFor({ state: "visible", timeout: 2000 });
            } catch {
                // Menu failed to open. Try clicking gear again to toggle/reset state.
                await gearBtn.click().catch(() => {});
                return;
            }

            // 5. Scrape Options
            const optionElements = await menu.locator('> *').all();
            const availableOptions: { text: string; element: any }[] = [];

            for (const el of optionElements) {
                const text = (await el.innerText()).trim();
                if (text && !text.toLowerCase().includes('auto')) {
                    availableOptions.push({ text, element: el });
                }
            }

            // 6. Select Best
            let targetOption = null;

            // A. Try explicit priority list first (exact matches)
            for (const priority of this.PRIORITIES) {
                targetOption = availableOptions.find(opt => opt.text === priority);
                if (targetOption) break;
            }

            // B. Fallback: Parse highest number
            if (!targetOption && availableOptions.length > 0) {
                const sorted = availableOptions.sort((a, b) => {
                    const valA = parseInt(a.text) || 0;
                    const valB = parseInt(b.text) || 0;
                    return valB - valA;
                });
                targetOption = sorted[0];
            }

            // 7. Act
            if (targetOption) {
                if (this.currentQuality !== targetOption.text) {
                    logger.info(`[SC] QualityManager: Switching to ${targetOption.text}`);
                    await targetOption.element.click();
                    this.currentQuality = targetOption.text;
                } else {
                    // Already on best. Close menu by clicking gear.
                    await gearBtn.click();
                }
            } else {
                // No valid options? Close menu.
                await gearBtn.click();
            }

        } catch (error: any) {
            // Page context might be destroyed
        }
    }
}