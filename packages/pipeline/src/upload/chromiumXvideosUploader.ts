import { access, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page, type Request } from "playwright";
import type { UploadReceipt, UploadRequest, XvideosUploader } from "./disabledXvideosUploader.js";
import { findXvideosEntry, type XvideosEntry, type XvideosEntryCandidate } from "./xvideosEntries.js";

const ACCOUNT_URL = "https://www.xvideos.com/account";
const UPLOAD_URL = "https://www.xvideos.com/account/uploads/new";
const UPLOADS_URL = "https://www.xvideos.com/account/uploads";
const MANUAL_MODEL_TIMEOUT_MILLISECONDS = 30 * 60_000;

export interface ChromiumUploaderConfig {
    readonly executablePath: string;
    readonly profilePath: string;
    readonly email: string;
    readonly password: string;
    readonly headless?: boolean;
}

export class HumanActionRequiredError extends Error {
    constructor(readonly action: "captcha" | "google_challenge" | "session_login" | "model_selection", message: string) {
        super(message);
        this.name = "HumanActionRequiredError";
    }
}

class RequestByteCounter {
    private readonly seen = new Set<Request>();
    private bytes = 0;

    async observe(request: Request): Promise<void> {
        if (this.seen.has(request) || request.method() === "GET") return;
        this.seen.add(request);
        const url = new URL(request.url());
        if (!url.hostname.endsWith("xvideos.com") && !url.hostname.endsWith("upload-serv.com")) return;
        const raw = await request.headerValue("content-length");
        const length = raw ? Number.parseInt(raw, 10) : 0;
        if (Number.isSafeInteger(length) && length > 0) this.bytes += length;
    }

    transmitted(fallback: number): number { return Math.max(this.bytes, fallback); }
}

export class ChromiumXvideosUploader implements XvideosUploader {
    constructor(private readonly config: ChromiumUploaderConfig) {}

    async upload(request: UploadRequest): Promise<UploadReceipt> {
        await this.validateRequest(request);
        const context = await chromium.launchPersistentContext(this.config.profilePath, {
            executablePath: this.config.executablePath,
            headless: this.config.headless ?? false,
            viewport: null,
            args: ["--disable-blink-features=AutomationControlled"],
        });
        try {
            const page = context.pages()[0] ?? await context.newPage();
            const counter = new RequestByteCounter();
            page.on("request", (networkRequest) => { void counter.observe(networkRequest); });
            await this.ensureAuthenticated(page);
            await this.openUploadForm(page);
            await page.locator("#file_form_file_terms").check();
            await page.locator("#file_form_file_file_options_file_1_file").setInputFiles(request.artifactPath);
            await request.onProgress?.("file_uploading", request.sizeBytes);
            await page.getByRole("button", { name: "Upload", exact: true }).click();
            await page.getByText("The file upload was completed successfully.", { exact: false })
                .waitFor({ state: "visible", timeout: 30 * 60_000 });
            await request.onProgress?.("file_uploaded", counter.transmitted(request.sizeBytes));

            await this.fillUploadMetadata(page, request);
            const selectedModelId = await this.selectOrCreateModel(page, request);
            const submittedAt = new Date();
            await request.onProgress?.("metadata_submitting", counter.transmitted(request.sizeBytes));
            await Promise.all([
                page.waitForLoadState("domcontentloaded"),
                page.getByRole("button", { name: "Save modifications", exact: true }).click(),
            ]);
            await page.waitForTimeout(1_000);
            const remoteEntry = await this.findEntry(page, request.matchKey);
            return {
                transmittedBytes: counter.transmitted(request.sizeBytes),
                remoteEntry,
                metadataSubmittedAt: submittedAt.toISOString(),
                selectedModelId,
            };
        } finally {
            await context.close();
        }
    }

    async findEntryByMatchKey(matchKey: string): Promise<XvideosEntry | null> {
        const context = await chromium.launchPersistentContext(this.config.profilePath, {
            executablePath: this.config.executablePath,
            headless: this.config.headless ?? false,
            viewport: null,
        });
        try {
            const page = context.pages()[0] ?? await context.newPage();
            await this.ensureAuthenticated(page);
            return await this.findEntry(page, matchKey);
        } finally {
            await context.close();
        }
    }

    private async validateRequest(request: UploadRequest): Promise<void> {
        if (!/^[a-f0-9]{64}$/.test(request.recordingId)) throw new Error("Invalid pipeline recording ID");
        if (request.visibility !== "private") throw new Error("Only Direct-link XVideos uploads are supported");
        const artifactPath = path.resolve(request.artifactPath);
        await access(artifactPath);
        const stats = await stat(artifactPath);
        if (!stats.isFile() || stats.size !== request.sizeBytes) throw new Error("Upload artifact size no longer matches its ledger record");
        if (!request.title.includes(request.matchKey)) throw new Error("Upload title lacks its reconciliation match key");
        if (request.title.length > 255 || request.description.length > 1_000 || request.tags.length > 20) {
            throw new Error("Upload metadata exceeds XVideos limits");
        }
    }

    private async ensureAuthenticated(page: Page): Promise<void> {
        await page.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (await page.getByText("My Content", { exact: true }).count()) return;
        const google = page.locator("a.social-login-icon[data-name=Google][data-method=signin]");
        if (!await google.count()) throw new HumanActionRequiredError("session_login", "XVideos login form changed");
        await google.click();
        await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
        await page.waitForLoadState("domcontentloaded");
        if (await page.locator("#identifierId").count()) {
            await page.locator("#identifierId").fill(this.config.email);
            await page.getByRole("button", { name: "Next" }).click();
        }
        await page.waitForTimeout(750);
        if (await page.locator('input[type="password"]').count()) {
            await page.locator('input[type="password"]').fill(this.config.password);
            await page.getByRole("button", { name: "Next" }).click();
        }
        await page.waitForTimeout(1_000);
        const continueButton = page.getByRole("button", { name: "Continue" });
        if (await continueButton.count()) await continueButton.click();
        await page.waitForTimeout(1_000);
        if (!page.url().startsWith("https://www.xvideos.com/account")) {
            throw new HumanActionRequiredError("google_challenge", "Google requires manual account verification");
        }
    }

    private async openUploadForm(page: Page): Promise<void> {
        await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if ((await page.locator("body").innerText()).includes("Confirm that you are not a robot")) {
            throw new HumanActionRequiredError("captcha", "Friendly Captcha requires manual completion");
        }
        await page.locator("#file_form_file_file_options_file_1_file").waitFor({ state: "attached", timeout: 15_000 });
    }

    private async fillUploadMetadata(page: Page, request: UploadRequest): Promise<void> {
        await page.locator("#upload_form_safe_for_work_sfw_centered_sfw_status_NSFW").check();
        const categories = page.locator('input[name="upload_form[category][category_centered][category][]"]');
        for (let index = 0; index < await categories.count(); index++) {
            const category = categories.nth(index);
            const value = await category.getAttribute("value");
            if (value === "straight" || value === "solo_girls") await category.check();
            else if (await category.isChecked()) await category.uncheck();
        }
        await page.locator("#upload_form_networksites_networksites_centered_networksites_DEFAULT_ONLY").check();
        await page.locator("#upload_form_privacy_privacy_centered_privacy_NO_LISTING").check();
        await page.locator("#upload_form_titledesc_title").fill(request.title);
        await page.locator("#upload_form_titledesc_description").fill(request.description);
        for (const tag of request.tags) {
            const input = page.locator("#upload_form_tags .tag-list > input[type=text]");
            await input.fill(tag.replace(/-/g, " "));
            await input.press("Enter");
        }
        if (await page.locator("#upload_form_ads_has_commercial_com").isChecked()) {
            await page.locator("#upload_form_ads_has_commercial_com").uncheck();
        }
    }

    private async selectOrCreateModel(page: Page, request: UploadRequest): Promise<string | null> {
        if (!request.model) return null;
        const modelInput = page.locator("#upload_form_models .models-list > input[type=text]");
        await modelInput.fill(request.model.stageName);
        await page.locator("#upload_form_models button[data-role=add]").click();
        await page.waitForTimeout(500);
        if (request.model.selectionMode === "automatic-known") {
            if (!request.model.xvideosModelId) {
                throw new Error("Unattended campaign upload requires a previously confirmed XVideos model ID");
            }
            const candidate = page.locator(`[data-id="${request.model.xvideosModelId}"]`).first();
            if (!await candidate.count()) throw new Error("Configured XVideos model ID was not offered by the selector");
            await candidate.click();
            return request.model.xvideosModelId;
        }

        console.log(JSON.stringify({
            event: "xvideos-model-selection-required",
            stageName: request.model.stageName,
            instruction: "Select the correct existing model or click create model in the visible browser",
        }));
        const hiddenSelection = page.locator("#upload_form_models_modelsList");
        const initialSelection = await hiddenSelection.inputValue();
        const form = page.locator("form.model-info-form");
        let creationFormFilled = false;
        const deadline = Date.now() + MANUAL_MODEL_TIMEOUT_MILLISECONDS;
        while (Date.now() < deadline) {
            const value = await hiddenSelection.inputValue();
            if (value !== initialSelection && hasModelSelection(value)) {
                console.log(JSON.stringify({ event: "xvideos-model-selected" }));
                return extractSelectedModelId(value);
            }
            const formVisible = await form.isVisible().catch(() => false);
            if (formVisible && !creationFormFilled) {
                await form.locator('input[name="name"]').fill(request.model.stageName);
                await form.locator('select[name="sex"]').selectOption({ label: request.model.gender });
                await form.locator('textarea[name="who_are_they"]').fill(request.model.howKnown);
                await form.locator('input[name="profile_pic"]').setInputFiles(request.model.profilePicture);
                creationFormFilled = true;
                console.log(JSON.stringify({
                    event: "xvideos-model-creation-filled",
                    instruction: "Review the populated model form and submit it in the visible browser",
                }));
            } else if (!formVisible) {
                creationFormFilled = false;
            }
            await page.waitForTimeout(250);
        }
        throw new HumanActionRequiredError("model_selection", "Timed out waiting for manual XVideos model selection");
    }

    private async findEntry(page: Page, matchKey: string): Promise<XvideosEntry | null> {
        await page.goto(UPLOADS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const filter = page.locator("#videos-list-filter_title_tag_type_title_tags");
        if (await filter.count()) {
            await filter.fill(matchKey);
            const search = page.locator("#videos-list-filter").getByText("Search", { exact: true });
            if (await search.count()) {
                await search.click();
                await page.waitForLoadState("domcontentloaded");
            }
        }
        const candidates = await page.locator('[id^="listing-video-"]').evaluateAll((elements) => elements.map((element) => {
            const titleLink = [...element.querySelectorAll("a")].find((link) => {
                const href = link.getAttribute("href") ?? "";
                return href.startsWith("/video.");
            });
            return {
                containerId: element.id,
                remoteUrl: titleLink?.getAttribute("href") ?? "",
                title: titleLink?.textContent?.trim() ?? "",
                text: element.textContent ?? "",
            } satisfies XvideosEntryCandidate;
        }));
        return findXvideosEntry(candidates.map((candidate) => ({
            ...candidate,
            remoteUrl: candidate.remoteUrl ? new URL(candidate.remoteUrl, UPLOADS_URL).href : "",
        })), matchKey);
    }
}

function extractSelectedModelId(serialized: string): string | null {
    try {
        const parsed = JSON.parse(serialized) as unknown;
        const visit = (value: unknown): string | null => {
            if (Array.isArray(value)) {
                for (const item of value) {
                    const result = visit(item);
                    if (result) return result;
                }
            } else if (value && typeof value === "object") {
                for (const [key, item] of Object.entries(value)) {
                    if (/^(?:id|model_id|modelId)$/i.test(key)
                        && (typeof item === "string" || typeof item === "number")) return String(item);
                    const result = visit(item);
                    if (result) return result;
                }
            }
            return null;
        };
        return visit(parsed);
    } catch {
        return null;
    }
}

export function hasModelSelection(serialized: string): boolean {
    const trimmed = serialized.trim();
    if (!trimmed || trimmed === "[]" || trimmed === "{}" || trimmed === "null") return false;
    try {
        const value = JSON.parse(trimmed) as unknown;
        if (Array.isArray(value)) return value.length > 0;
        return value !== null && typeof value === "object" && Object.keys(value).length > 0;
    } catch {
        return true;
    }
}
