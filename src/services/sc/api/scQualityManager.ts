import { Page } from "playwright";
import logger from "../../../common/logger.js";

export class ScQualityManager {
    private page: Page;
    private intervalId: NodeJS.Timeout | null = null;
    private currentQuality: string | null = null;
    private lastVideoTime: number = -1;

    // --- CONFIGURATION ---
    private readonly ENABLE_LATENCY_TOGGLE = false; // Set to TRUE to enable latency switching
    // ---------------------

    private readonly CHECK_INTERVAL = 60000;
    private readonly PRIORITIES = ['1080p60', '1080p', '720p60', '720p'];

    constructor(page: Page) {
        this.page = page;
    }

    public start(): void {
        if (this.intervalId) return;
        logger.info("[SC] QualityManager started.");

        setTimeout(async () => {
            await this.ensurePlayerControlsVisible();
            if (this.ENABLE_LATENCY_TOGGLE) {
                await this.ensureLatencySettings();
            }

            await this.page.waitForTimeout(5000);

            await this.ensurePlayerControlsVisible();
            await this.checkAndSetQuality();
        }, 15000);

        this.intervalId = setInterval(async () => {
            await this.ensurePlayerControlsVisible();

            // FREEZE DETECTION
            const isFrozen = await this.checkIfFrozen();
            if (isFrozen) {
                logger.warn("[SC] Stream freeze detected.");
                if (this.ENABLE_LATENCY_TOGGLE) {
                    logger.info("[SC] Toggling latency to attempt fix...");
                    await this.toggleLatency();
                    return;
                } else {
                    logger.info("[SC] Latency toggle disabled. Skipping fix.");
                }
            }

            if (this.ENABLE_LATENCY_TOGGLE) {
                await this.ensureLatencySettings();
            }
            await this.checkAndSetQuality();
        }, this.CHECK_INTERVAL);
    }

    public stop(): void {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    private async checkIfFrozen(): Promise<boolean> {
        try {
            if (this.page.isClosed()) return false;
            const currentTime = await this.page.evaluate(() => {
                const v = document.querySelector('video');
                return v ? v.currentTime : -1;
            });

            if (currentTime === -1) return false;

            const frozen = (Math.abs(currentTime - this.lastVideoTime) < 0.1 && currentTime > 0.5);
            this.lastVideoTime = currentTime;
            return frozen;
        } catch (e) {
            return false;
        }
    }

    private async ensurePlayerControlsVisible(): Promise<void> {
        try {
            if (this.page.isClosed()) return;
            const gearBtn = this.page.locator('.player-resolution').first();
            if (await gearBtn.isVisible()) return;

            await this.page.evaluate(() => {
                const videoContainer = document.querySelector('.player-container') || document.querySelector('video')?.parentElement;
                if (videoContainer) {
                    videoContainer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 100, clientY: 100 }));
                    videoContainer.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                }
            });
            await this.page.waitForTimeout(1000);
        } catch (e) { /* ignore */ }
    }

    private async toggleLatency(): Promise<void> {
        if (!this.ENABLE_LATENCY_TOGGLE) return;
        try {
            if (this.page.isClosed()) return;
            const lightningBtn = this.page.locator('.player-low-latency-button').first();
            if (!(await lightningBtn.isVisible())) return;

            await lightningBtn.click({ force: true });
            await this.page.waitForTimeout(2000);

            const latencyRow = this.page.locator('.player-low-latency-dropdown__toggler').filter({ hasText: 'Ultra-low Latency' }).first();
            if (await latencyRow.isVisible()) {
                const input = latencyRow.locator('input');
                if ((await input.count()) > 0) {
                    await input.click({ force: true });
                } else {
                    await latencyRow.click({ force: true });
                }
                await this.page.waitForTimeout(2000);
            } else {
                await lightningBtn.click({ force: true }).catch(() => {});
            }
        } catch (e) {
            logger.warn(`[SC] Error toggling latency: ${(e as Error).message}`);
        }
    }

    private async ensureLatencySettings(): Promise<void> {
        if (!this.ENABLE_LATENCY_TOGGLE) return;
        try {
            if (this.page.isClosed()) return;

            const lightningBtn = this.page.locator('.player-low-latency-button').first();
            if (!(await lightningBtn.isVisible())) return;

            await lightningBtn.click({ force: true });
            await this.page.waitForTimeout(2000);

            const latencyRow = this.page.locator('.player-low-latency-dropdown__toggler').filter({ hasText: 'Ultra-low Latency' }).first();

            if (await latencyRow.isVisible()) {
                let isOn = false;
                const input = latencyRow.locator('input');

                if ((await input.count()) > 0) {
                    isOn = await input.isChecked();
                } else {
                    const switchEl = latencyRow.locator('.switch, .toggle, [class*="switch"]').first();
                    if ((await switchEl.count()) > 0) {
                        const classes = await switchEl.getAttribute('class') || '';
                        isOn = classes.includes('active') || classes.includes('checked') || classes.includes('on');
                    } else {
                        const rowClasses = await latencyRow.getAttribute('class') || '';
                        isOn = rowClasses.includes('active') || rowClasses.includes('checked');
                    }
                }

                if (!isOn) {
                    logger.info("[SC] QualityManager: Enabling Ultra-low Latency");
                    if ((await input.count()) > 0) {
                        await input.click({ force: true });
                    } else {
                        await latencyRow.click({ force: true });
                    }
                    await this.page.waitForTimeout(2000);
                } else {
                    await lightningBtn.click({ force: true }).catch(() => {});
                    await this.page.waitForTimeout(1000);
                }
            } else {
                await lightningBtn.click({ force: true }).catch(() => {});
                await this.page.waitForTimeout(1000);
            }
        } catch (error: any) {
            logger.warn(`[SC] Error ensuring latency settings: ${error.message}`);
        }
    }

    private async checkAndSetQuality(): Promise<void> {
        try {
            if (this.page.isClosed()) return;

            const gearBtn = this.page.locator('.player-resolution').first();
            if (!(await gearBtn.isVisible())) return;

            await gearBtn.click({ force: true });

            const menu = this.page.locator('.player-resolution-tooltip__resolutions');
            try {
                await menu.waitFor({ state: "visible", timeout: 3000 });
                await this.page.waitForTimeout(1000);
            } catch {
                await gearBtn.click({ force: true }).catch(() => {});
                return;
            }

            const optionElements = await menu.locator('> *').all();
            const availableOptions: { text: string; element: any }[] = [];

            for (const el of optionElements) {
                const text = (await el.innerText()).trim();
                if (text && !text.toLowerCase().includes('auto') && !text.toLowerCase().includes('latency')) {
                    availableOptions.push({ text, element: el });
                }
            }

            let targetOption = null;
            for (const priority of this.PRIORITIES) {
                targetOption = availableOptions.find(opt => opt.text === priority);
                if (targetOption) break;
            }

            if (!targetOption && availableOptions.length > 0) {
                const sorted = availableOptions.sort((a, b) => {
                    const valA = parseInt(a.text) || 0;
                    const valB = parseInt(b.text) || 0;
                    return valB - valA;
                });
                targetOption = sorted[0];
            }

            if (targetOption) {
                const classAttr = await targetOption.element.getAttribute('class') || '';
                const isActive = classAttr.includes('active') || classAttr.includes('selected');

                if (!isActive && this.currentQuality !== targetOption.text) {
                    logger.info(`[SC] QualityManager: Switching to ${targetOption.text}`);
                    await targetOption.element.click({ force: true });
                    this.currentQuality = targetOption.text;
                    await this.page.waitForTimeout(2000);
                } else {
                    await gearBtn.click({ force: true });
                    await this.page.waitForTimeout(1000);
                }
            } else {
                await gearBtn.click({ force: true });
                await this.page.waitForTimeout(1000);
            }
        } catch (error: any) {
            // Squelch
        }
    }
}