import { access, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import type { UploadOutcome, UploadRequest, XvideosUploader } from "./disabledXvideosUploader.js";
import { filterXvideosEntries, type XvideosEntry, type XvideosEntryCandidate } from "./xvideosEntries.js";

const ACCOUNT_URL = "https://www.xvideos.com/account";
const UPLOAD_URL = "https://www.xvideos.com/account/uploads/new";
const UPLOADS_URL = "https://www.xvideos.com/account/uploads";

export interface ChromiumUploaderConfig {
    readonly executablePath: string;
    readonly profilePath: string;
    readonly email: string;
    readonly password: string;
    readonly headless?: boolean;
}

export class HumanActionRequiredError extends Error {
    constructor(readonly action: "captcha" | "google_challenge" | "session_login", message: string) {
        super(message);
        this.name = "HumanActionRequiredError";
    }
}

class RequestByteCounter {
    private readonly seen = new Set<Request>();
    private bytes = 0;

    async observe(request: Request): Promise<void> {
        try {
            if (this.seen.has(request) || request.method() === "GET") return;
            this.seen.add(request);
            const url = new URL(request.url());
            if (!url.hostname.endsWith("xvideos.com") && !url.hostname.endsWith("upload-serv.com")) return;
            const raw = await request.headerValue("content-length");
            const length = raw ? Number.parseInt(raw, 10) : 0;
            if (Number.isSafeInteger(length) && length > 0) this.bytes += length;
        } catch {
            // aborted or intercepted request; not billable and never fatal
        }
    }

    transmitted(fallback: number): number { return Math.max(this.bytes, fallback); }
}

export class ChromiumXvideosUploader implements XvideosUploader {
    constructor(private readonly config: ChromiumUploaderConfig) {}

    async upload(request: UploadRequest): Promise<UploadOutcome> {
        await this.validateRequest(request);
        const context = await chromium.launchPersistentContext(this.config.profilePath, {
            executablePath: this.config.executablePath,
            headless: this.config.headless ?? false,
            viewport: null,
            args: ["--disable-blink-features=AutomationControlled", "--remote-debugging-port=9222"],
            ignoreDefaultArgs: ["--enable-automation"],
        }).catch((error: unknown) => {
            throw new HumanActionRequiredError("session_login",
                "Could not launch the XVideos browser profile. If an earlier run left a browser open, close it manually first. "
                + (error instanceof Error ? error.message : String(error)));
        });
        let completed = false;
        try {
            const page = context.pages()[0] ?? await context.newPage();
            const counter = new RequestByteCounter();
            page.on("request", (networkRequest) => { void counter.observe(networkRequest); });
            await this.ensureAuthenticated(page);
            // Backup remote check inside this same session: the folder name is
            // the local truth, the edit-page title is the XVideos truth. No
            // second browser launch, no second login.
            const existing = await this.findUploadedCopyOnPage(page, request.recordingId);
            if (existing.kind === "found") {
                completed = true;
                return { kind: "existing", remoteId: existing.remoteId, remoteUrl: existing.remoteUrl };
            }
            if (existing.kind === "title_mismatch") {
                completed = true;
                return { kind: "title_mismatch", remoteId: existing.remoteId };
            }
            await this.openUploadForm(page);
            await page.locator("#file_form_file_terms").check();
            await page.locator("#file_form_file_file_options_file_1_file").setInputFiles(request.artifactPath);
            await request.onProgress?.("file_uploading", request.sizeBytes);
            await page.getByRole("button", { name: "Upload", exact: true }).click();
            // The file now uploads in the background. From here on the run must
            // not die on a 30-second action timeout: the form may stay hidden or
            // disabled while the transfer progresses, so every action waits
            // patiently until the page is ready.
            page.setDefaultTimeout(5 * 60_000);
            console.log(JSON.stringify({ event: "xvideos-upload-started", instruction: "Filling metadata while the file uploads" }));
            await page.locator("#upload_form").waitFor({ state: "visible", timeout: 30 * 60_000 });
            await this.fillUploadMetadata(page, request);
            await page.getByText("The file upload was completed successfully.", { exact: false })
                .waitFor({ state: "visible", timeout: 30 * 60_000 });
            await request.onProgress?.("file_uploaded", counter.transmitted(request.sizeBytes));

            await this.typeModelAlias(page, request.streamerAlias);
            const submittedAt = new Date();
            await request.onProgress?.("metadata_submitting", counter.transmitted(request.sizeBytes));
            await Promise.all([
                page.waitForLoadState("domcontentloaded"),
                page.getByRole("button", { name: "Save modifications", exact: true }).click(),
            ]);
            await page.waitForTimeout(1_000);
            // Success is NOT decided here: the attempt parks as uncertain and
            // the 24-hour reconcile verifies the edit page.
            const submittedId = await this.captureSubmittedVideoId(page, request.recordingId);
            completed = true;
            return {
                kind: "uploaded",
                receipt: {
                    transmittedBytes: counter.transmitted(request.sizeBytes),
                    submittedVideoId: submittedId,
                    metadataSubmittedAt: submittedAt.toISOString(),
                },
            };
        } finally {
            if (completed) {
                await context.close();
            } else {
                console.log(JSON.stringify({
                    event: "upload-browser-left-open",
                    instruction: "The upload did not complete cleanly, so the browser was left open for manual handling. Close it manually before running another upload.",
                }));
            }
        }
    }

    async probeUploadStatus(page: Page, uploadId: string): Promise<{
        outcome: "online" | "not_ready";
        remoteUrl: string | null;
    }> {
        const response = await page.goto(`https://www.xvideos.com/account/uploads/${uploadId}/edit`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        if ((response?.status() ?? 0) >= 400) {
            return { outcome: "not_ready", remoteUrl: null };
        }
        // Online check: the edit page shows the "Direct link to the video
        // page" anchor only once the video is published.
        const directLink = page.locator('a[href*="/video."]').first();
        const href = await directLink.getAttribute("href").catch(() => null);
        if (!href) {
            return { outcome: "not_ready", remoteUrl: null };
        }
        return {
            outcome: "online",
            remoteUrl: new URL(href, "https://www.xvideos.com/").href,
        };
    }

    // One login flow, then the callers run their specific work on the
    // authenticated page. Reconcile and any future checks share this instead
    // of each launching their own browser and login.
    async withAuthenticatedPage<T>(run: (page: Page) => Promise<T>): Promise<T> {
        const context = await chromium.launchPersistentContext(this.config.profilePath, {
            executablePath: this.config.executablePath,
            headless: this.config.headless ?? false,
            viewport: null,
            args: ["--disable-blink-features=AutomationControlled", "--remote-debugging-port=9222"],
            ignoreDefaultArgs: ["--enable-automation"],
        }).catch((error: unknown) => {
            throw new HumanActionRequiredError("session_login",
                "Could not launch the XVideos browser profile. If an earlier run left a browser open, close it manually first. "
                + (error instanceof Error ? error.message : String(error)));
        });
        try {
            const page = context.pages()[0] ?? await context.newPage();
            await this.ensureAuthenticated(page);
            return await run(page);
        } finally {
            await context.close();
        }
    }

    private async validateRequest(request: UploadRequest): Promise<void> {
        if (!request.recordingId.trim()) throw new Error("Upload request lacks a recording identity");
        if (request.visibility !== "private") throw new Error("Only Direct-link XVideos uploads are supported");
        const artifactPath = path.resolve(request.artifactPath);
        await access(artifactPath);
        const stats = await stat(artifactPath);
        if (!stats.isFile() || stats.size !== request.sizeBytes) throw new Error("Upload artifact size no longer matches its ledger record");
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
        const signInWithGoogle = page.getByRole("button", { name: "Sign in with Google", exact: true });
        await signInWithGoogle.waitFor({ state: "visible", timeout: 15_000 });
        await signInWithGoogle.click();

        // Drive the Google OAuth flow across every page of the context: it
        // may run in the same tab or in a popup, and with a saved Google
        // session it can complete instantly without ever showing a Google
        // page. Completion is therefore verified by probing the XVideos
        // dashboard in a spare tab instead of watching URLs. Possible steps
        // are the account chooser, the identifier page, the password page,
        // and the consent "Continue" button. A persistent manual challenge
        // (2FA, recovery, unusual activity) is reported as a human action
        // instead of being retried blindly.
        const context = page.context();
        const startedAt = Date.now();
        const deadline = startedAt + 180_000;
        let stepsTaken = 0;
        let challengeStreak = 0;
        let lastProbeAt = 0;
        let verified = false;
        while (Date.now() < deadline && !verified) {
            let sawGooglePage = false;
            let acted = false;
            for (const candidate of context.pages()) {
                try {
                    const url = candidate.url();
                    if (url.startsWith("https://accounts.google.com")) sawGooglePage = true;
                    const accountRow = candidate.locator(
                        `[data-identifier="${this.config.email}"], [data-email="${this.config.email}"]`,
                    ).first();
                    if (await accountRow.count()) {
                        await accountRow.click();
                        acted = true;
                        stepsTaken++;
                        continue;
                    }
                    if (await candidate.locator("#identifierId").count()) {
                        await candidate.locator("#identifierId").fill(this.config.email);
                        await candidate.getByRole("button", { name: "Next", exact: true }).click();
                        acted = true;
                        stepsTaken++;
                        continue;
                    }
                    if (await candidate.locator('input[type="password"]').count()) {
                        await candidate.locator('input[type="password"]').fill(this.config.password);
                        await candidate.getByRole("button", { name: "Next", exact: true }).click();
                        acted = true;
                        stepsTaken++;
                        continue;
                    }
                    const continueButton = candidate.getByRole("button", { name: "Continue", exact: true });
                    if (await continueButton.count()) {
                        await continueButton.click();
                        acted = true;
                        stepsTaken++;
                        continue;
                    }
                    const text = await candidate.locator("body").innerText().catch(() => "");
                    if (sawGooglePage && /confirm it.s you|verify it.s you|2-step verification|two-step verification|try another way|recover your account|unusual activity/i.test(text)) {
                        challengeStreak++;
                        if (challengeStreak >= 2) {
                            throw new HumanActionRequiredError("google_challenge",
                                "Google requires manual account verification: " + text.slice(0, 200));
                        }
                    }
                } catch {
                    // page closed or navigating; retry next iteration
                }
            }
            if (acted) challengeStreak = 0;
            if (!sawGooglePage && !acted && (stepsTaken > 0 || Date.now() - startedAt > 3_000)) {
                if (Date.now() - lastProbeAt > 8_000) {
                    lastProbeAt = Date.now();
                    verified = await this.verifyAccountDashboard(context);
                }
            }
            await page.waitForTimeout(750);
        }
        if (!verified) {
            await page.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
            if (!await page.getByText("My Content", { exact: true }).count()) {
                throw new HumanActionRequiredError("google_challenge", "Google login did not reach the XVideos account dashboard");
            }
        }
    }

    private async verifyAccountDashboard(context: BrowserContext): Promise<boolean> {
        const probe = await context.newPage();
        try {
            await probe.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
            return await probe.getByText("My Content", { exact: true }).count() > 0;
        } catch {
            return false;
        } finally {
            await probe.close().catch(() => undefined);
        }
    }

    private async openUploadForm(page: Page): Promise<void> {
        await page.goto(UPLOAD_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await this.solveFriendlyCaptcha(page);
        await page.locator("#file_form_file_file_options_file_1_file").waitFor({ state: "attached", timeout: 15_000 });
    }

    private async solveFriendlyCaptcha(page: Page): Promise<void> {
        const fileInput = page.locator("#file_form_file_file_options_file_1_file");
        const confirmButton = page.getByRole("button", { name: "Confirm that you are not a robot", exact: true });
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (await fileInput.count()) return;
            // Friendly Captcha does not auto-solve on the upload page: its
            // widget checkbox has to be clicked, the proof-of-work runs for a
            // few seconds, and only then does the page-level confirm button
            // accept a click and reveal the file form.
            let widgetSolved = false;
            for (const frame of page.frames()) {
                try {
                    if (!frame.url().includes("frcapi.com/api/v2/captcha/widget")) continue;
                    const checkbox = frame.locator("button[role=checkbox]").first();
                    if (!await checkbox.count()) continue;
                    const stateClass = await frame.locator(".main").first()
                        .getAttribute("class").catch(() => "") ?? "";
                    // Click only the unactivated widget; while it solves, wait.
                    // Re-clicking restarts the proof-of-work and escalates the
                    // captcha difficulty, which caused a minute-long stall.
                    if (stateClass.includes("state-unactivated")) {
                        await checkbox.click({ timeout: 5_000 }).catch(() => undefined);
                    }
                    const checked = await checkbox.getAttribute("aria-checked").catch(() => null);
                    widgetSolved = checked === "true" || stateClass.includes("state-completed");
                } catch {
                    // widget frame still mounting or detaching; retry next iteration
                }
            }
            if (widgetSolved && await confirmButton.count() && await confirmButton.isEnabled()) {
                await confirmButton.click();
                await page.waitForTimeout(1_500);
                continue;
            }
            await page.waitForTimeout(750);
        }
        if (!await fileInput.count()) {
            throw new HumanActionRequiredError("captcha", "Friendly Captcha did not complete automatically on the upload page");
        }
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
        const tagInput = page.locator("#upload_form_tags .tag-list > input[type=text]");
        for (const tag of request.tags) {
            // The tag input is zero-width until it receives text, so Playwright
            // treats it as invisible and fill() can never work. focus() only
            // requires attachment, and page.keyboard has no actionability
            // checks: focus, type, and press Enter. The widget expands the
            // input as text arrives and adds the chip on Enter.
            await tagInput.focus();
            await page.keyboard.type(tag.replace(/-/g, " "));
            await page.keyboard.press("Enter");
        }
        if (await page.locator("#upload_form_ads_has_commercial_com").isChecked()) {
            await page.locator("#upload_form_ads_has_commercial_com").uncheck();
        }
    }

    private async typeModelAlias(page: Page, alias: string | undefined): Promise<void> {
        if (!alias) return;
        // The model input is a zero-width typeahead (Playwright treats it as
        // invisible, so fill() can never work), and XVideos does NOT require a
        // real model selection: typing the streamer alias and clicking Save
        // submits successfully with an empty model list.
        const modelInput = page.locator("#upload_form_models .models-list > input[type=text]");
        await modelInput.focus();
        await page.keyboard.type(alias);
    }

    private async captureSubmittedVideoId(page: Page, folderName: string): Promise<string | null> {
        // After saving, XVideos first shows "Processing video 0% Publication:
        // pending" and only reveals the "edit it here" link once the panel
        // updates to "Video processed. Publication succeeded." (measured live:
        // ~20 seconds). Poll for the link instead of reading once.
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
            const links = await page.locator('a[href*="/account/uploads/"]')
                .evaluateAll((elements) => elements.map((element) => element.getAttribute("href") ?? ""))
                .catch(() => [] as string[]);
            for (const raw of [page.url(), ...links]) {
                const match = raw.match(/\/account\/uploads\/(\d+)\/edit/);
                if (match?.[1]) return match[1];
            }
            await page.waitForTimeout(2_000);
        }
        // Fallback: the panel never revealed the link — look the upload up in
        // the authenticated uploads list by the folder name (the title carries
        // it). The filter is a server-side search (/account/uploads/f:t:<query>,
        // verified live) that surfaces matches regardless of list pagination.
        try {
            const entries = await this.findEntries(page, folderName);
            if (entries.length > 0) return entries[0].remoteId;
        } catch {
            // list unreachable; manual review remains the last resort
        }
        return null;
    }

    async findEntries(page: Page, searchTerm: string): Promise<XvideosEntry[]> {
        await page.goto(UPLOADS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const filter = page.locator("#videos-list-filter_title_tag_type_title_tags");
        if (await filter.count()) {
            await filter.fill(searchTerm);
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
            } satisfies XvideosEntryCandidate;
        }));
        return filterXvideosEntries(candidates.map((candidate) => ({
            ...candidate,
            remoteUrl: candidate.remoteUrl ? new URL(candidate.remoteUrl, UPLOADS_URL).href : "",
        })), searchTerm);
    }

    // Admission-time existence check: the folder name is the local truth, the
    // edit-page title is the XVideos truth. Runs in its own session for
    // remux-one/campaign intake, and inside the upload session as the backup.
    async findUploadedCopy(folderName: string): Promise<
        | { kind: "found"; remoteId: string; remoteUrl: string }
        | { kind: "title_mismatch"; remoteId: string }
        | { kind: "not_found" }
    > {
        return await this.withAuthenticatedPage((page) => this.findUploadedCopyOnPage(page, folderName));
    }

    async findUploadedCopyOnPage(page: Page, folderName: string): Promise<
        | { kind: "found"; remoteId: string; remoteUrl: string }
        | { kind: "title_mismatch"; remoteId: string }
        | { kind: "not_found" }
    > {
        const entries = await this.findEntries(page, folderName);
        for (const entry of entries) {
            await page.goto(`https://www.xvideos.com/account/uploads/${entry.remoteId}/edit`, {
                waitUntil: "domcontentloaded",
                timeout: 30_000,
            });
            const title = await page.title().catch(() => "");
            if (title.includes(`[${folderName}]`)) {
                return { kind: "found", remoteId: entry.remoteId, remoteUrl: entry.remoteUrl };
            }
        }
        if (entries.length > 0) {
            return { kind: "title_mismatch", remoteId: entries[0].remoteId };
        }
        return { kind: "not_found" };
    }
}
