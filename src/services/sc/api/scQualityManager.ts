import { Page } from "playwright";
import logger from "../../../common/logger.js";

export class ScQualityManager {
    private page: Page;
    private intervalId: NodeJS.Timeout | null = null;
    private currentQuality: string | null = null;
    // Slow down significantly to avoid 429/Rate Limiting
    private readonly CHECK_INTERVAL = 60000;
    private readonly PRIORITIES = ['1080p60', '1080p', '720p60', '720p'];

    constructor(page: Page) {
        this.page = page;
    }

    public start(): void {
        if (this.intervalId) return;
        logger.info("[SC] QualityManager started.");

        // Initial sequence: Wait 15s for page/player to settle before touching anything
        setTimeout(async () => {
            await this.ensurePlayerControlsVisible();
            await this.ensureLatencySettings();

            // Wait 5 seconds between operations to be gentle
            await this.page.waitForTimeout(5000);

            await this.ensurePlayerControlsVisible();
            await this.checkAndSetQuality();
        }, 15000);

        this.intervalId = setInterval(async () => {
            await this.ensurePlayerControlsVisible();
            await this.checkAndSetQuality();
        }, this.CHECK_INTERVAL);
    }

    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private async ensurePlayerControlsVisible(): Promise<void> {
        try {
            if (this.page.isClosed()) return;

            // Optimization: Don't spam mouse events if controls are already there
            const gearBtn = this.page.locator('.player-resolution').first();
            if (await gearBtn.isVisible()) {
                return;
            }

            await this.page.evaluate(() => {
                const videoContainer = document.querySelector('.player-container') || document.querySelector('video')?.parentElement;
                if (videoContainer) {
                    videoContainer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
                    videoContainer.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                }
            });
            // Wait longer for fade-in
            await this.page.waitForTimeout(1000);
        } catch (e) {
            // Ignore errors if page is closing
        }
    }

    private async ensureLatencySettings(): Promise<void> {
        try {
            if (this.page.isClosed()) return;

            // 1. Find Lightning Button
            const lightningBtn = this.page.locator('.player-low-latency-button').first();
            if (!(await lightningBtn.isVisible())) {
                logger.debug("[SC] Latency button not visible.");
                return;
            }

            // 2. Open Menu
            await lightningBtn.click();
            await this.page.waitForTimeout(2000); // Slow down

            // 3. Find "Ultra-low Latency" Row
            const latencyRow = this.page.locator('.player-low-latency-dropdown__toggler').filter({ hasText: 'Ultra-low Latency' }).first();

            if (await latencyRow.isVisible()) {
                let isOn = false;

                // Check for <input> (Best check)
                const input = latencyRow.locator('input');
                if ((await input.count()) > 0) {
                    isOn = await input.isChecked();
                } else {
                    // Fallback: Check for switch/toggle element classes
                    const switchEl = latencyRow.locator('.switch, .toggle, [class*="switch"]').first();
                    if ((await switchEl.count()) > 0) {
                        const classes = await switchEl.getAttribute('class') || '';
                        isOn = classes.includes('active') || classes.includes('checked') || classes.includes('on');
                    } else {
                        // Fallback: Check row classes
                        const rowClasses = await latencyRow.getAttribute('class') || '';
                        isOn = rowClasses.includes('active') || rowClasses.includes('checked');
                    }
                }

                if (!isOn) {
                    logger.info("[SC] QualityManager: Enabling Ultra-low Latency");
                    if ((await input.count()) > 0) {
                        await input.click();
                    } else {
                        await latencyRow.click();
                    }
                    // Wait after click to let it register/save
                    await this.page.waitForTimeout(2000);
                } else {
                    logger.debug("[SC] Ultra-low Latency is already ON.");
                    // Close menu since we didn't toggle it
                    await lightningBtn.click().catch(() => {});
                    await this.page.waitForTimeout(1000);
                }
            } else {
                logger.warn("[SC] 'Ultra-low Latency' option not found in menu.");
                // Close menu
                await lightningBtn.click().catch(() => {});
                await this.page.waitForTimeout(1000);
            }

        } catch (error: any) {
            logger.warn(`[SC] Error ensuring latency settings: ${error.message}`);
        }
    }

    private async checkAndSetQuality(): Promise<void> {
        try {
            if (this.page.isClosed()) return;

            // 1. Find Gear Button
            const gearBtn = this.page.locator('.player-resolution').first();
            if (!(await gearBtn.isVisible())) return;

            // 2. Click Gear
            await gearBtn.click();

            // 3. Wait for Menu - Increased timeout for slowness
            const menu = this.page.locator('.player-resolution-tooltip__resolutions');
            try {
                await menu.waitFor({ state: "visible", timeout: 3000 });
                // Extra wait for list population
                await this.page.waitForTimeout(1000);
            } catch {
                await gearBtn.click().catch(() => {});
                return;
            }

            // 4. Scrape Options
            const optionElements = await menu.locator('> *').all();
            const availableOptions: { text: string; element: any }[] = [];

            for (const el of optionElements) {
                const text = (await el.innerText()).trim();
                if (text && !text.toLowerCase().includes('auto') && !text.toLowerCase().includes('latency')) {
                    availableOptions.push({ text, element: el });
                }
            }

            // 5. Select Best
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

            // 6. Act
            if (targetOption) {
                const classAttr = await targetOption.element.getAttribute('class') || '';
                const isActive = classAttr.includes('active') || classAttr.includes('selected');

                if (!isActive && this.currentQuality !== targetOption.text) {
                    logger.info(`[SC] QualityManager: Switching to ${targetOption.text}`);
                    await targetOption.element.click();
                    this.currentQuality = targetOption.text;
                    // Wait for switch to apply
                    await this.page.waitForTimeout(2000);
                } else {
                    // Already on best. Close menu.
                    await gearBtn.click();
                    await this.page.waitForTimeout(1000);
                }
            } else {
                // No valid options. Close menu.
                await gearBtn.click();
                await this.page.waitForTimeout(1000);
            }

        } catch (error: any) {
            // Squelch errors during shutdown/nav
        }
    }
}