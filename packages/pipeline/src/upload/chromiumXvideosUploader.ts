import { access, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import type { UploadOutcome, UploadRequest, XvideosUploader } from "./disabledXvideosUploader.js";
import { filterXvideosEntries, type XvideosEntry, type XvideosEntryCandidate } from "./xvideosEntries.js";
import { hasDiagnosticUploadIdentity } from "../metadata/composeUploadMetadata.js";
import { limitedVisibilityWarning } from "./providerWarnings.js";
import { hasFullHdPlayback, parsePlaybackRenditions, type PlaybackRendition } from "./playbackQuality.js";
import { submitPasswordLogin } from "./passwordLogin.js";

const ACCOUNT_URL = "https://www.xvideos.com/account";
const UPLOAD_URL = "https://www.xvideos.com/account/uploads/new";
const UPLOADS_URL = "https://www.xvideos.com/account/uploads";

export interface ChromiumUploaderConfig {
    readonly executablePath: string;
    readonly profilePath: string;
    readonly email: string;
    readonly password: string;
    readonly headless?: boolean;
    // Interactive (manual upload-one) runs keep the browser open on failure so
    // a human can finish the job by hand. Unattended runs (the campaign) set
    // this to false: every failure closes the browser so it never holds the
    // profile lock against the next step.
    readonly leaveOpenOnFailure?: boolean;
}

export class HumanActionRequiredError extends Error {
    constructor(readonly action: "captcha" | "session_login" | "daily_limit", message: string) {
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
    readonly provider = "xvideos" as const;
    constructor(private readonly config: ChromiumUploaderConfig) {}

    async upload(request: UploadRequest): Promise<UploadOutcome> {
        await this.validateRequest(request);
        const context = await chromium.launchPersistentContext(this.config.profilePath, {
            executablePath: this.config.executablePath,
            headless: this.config.headless ?? false,
            viewport: null,
            args: ["--disable-blink-features=AutomationControlled", "--remote-debugging-port=9222"],
            ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
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
            await this.authenticateForUpload(page);
            // Search the exact bracketed filename, never the model-written title.
            const titleIdentity = hasDiagnosticUploadIdentity(request.title, request.uploadIdentity)
                ? request.uploadIdentity : hasDiagnosticUploadIdentity(request.title, request.recordingId)
                    ? request.recordingId : null;
            if (request.lookupBeforeUpload && !titleIdentity) throw new Error("Retry has no exact filename identity");
            const existing = titleIdentity && (request.lookupBeforeUpload || titleIdentity === request.uploadIdentity)
                ? await this.findUploadedCopyOnPage(page, titleIdentity) : { kind: "not_found" as const };
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
            await this.saveSubmissionEvidence(page, request, "file_uploaded");

            await this.typeModelAlias(page, request.streamerAlias);
            const submittedAt = new Date();
            await request.onProgress?.("metadata_submitting", counter.transmitted(request.sizeBytes));
            await Promise.all([
                page.waitForLoadState("domcontentloaded"),
                page.getByRole("button", { name: "Save modifications", exact: true }).click(),
            ]);
            await page.waitForTimeout(1_000);
            await this.saveSubmissionEvidence(page, request, "metadata_submitted");
            // Success is NOT decided here: the attempt parks as uncertain and
            // the 24-hour reconcile verifies the edit page.
            const submittedId = await this.captureSubmittedVideoId(page, titleIdentity, request);
            if (submittedId) await request.onEvidence?.({ stage: "remote_identity_captured", remoteId: submittedId });
            await this.saveSubmissionEvidence(page, request, "capture_complete");
            completed = true;
            return {
                kind: "uploaded",
                receipt: {
                    transmittedBytes: counter.transmitted(request.sizeBytes),
                    submittedVideoId: submittedId,
                    metadataSubmittedAt: submittedAt.toISOString(),
                },
            };
        } catch (error) {
            const page = context.pages()[0];
            if (page) await this.saveSubmissionEvidence(page, request, "submission_error").catch(() => undefined);
            throw error;
        } finally {
            if (completed || this.config.leaveOpenOnFailure === false) {
                await context.close();
            } else {
                console.log(JSON.stringify({
                    event: "upload-browser-left-open",
                    instruction: "The upload did not complete cleanly, so the browser was left open for manual handling. Close it manually before running another upload.",
                }));
            }
        }
    }

    // One edit-page read serves both the online check (direct link) and the
    // existence check (title). No duplicated navigation or parsing.
    private async readEditPage(page: Page, uploadId: string): Promise<{ title: string; directLink: string | null }> {
        const response = await page.goto(`https://www.xvideos.com/account/uploads/${uploadId}/edit`, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        if ((response?.status() ?? 0) >= 400) {
            return { title: "", directLink: null };
        }
        const title = await page.title().catch(() => "");
        const href = await page.locator('a[href*="/video."]').first()
            .getAttribute("href").catch(() => null);
        return {
            title,
            directLink: href ? new URL(href, "https://www.xvideos.com/").href : null,
        };
    }

    async probeUploadStatus(page: Page, uploadId: string): Promise<{
        outcome: "online" | "not_ready";
        remoteUrl: string | null;
        renditions?: PlaybackRendition[];
        reason?: string;
    }> {
        // Online check: the edit page shows the "Direct link to the video
        // page" anchor only once the video is published.
        const edit = await this.readEditPage(page, uploadId);
        if (!edit.title || !edit.directLink) {
            return { outcome: "not_ready", remoteUrl: null };
        }
        const response = await page.request.get(edit.directLink, { timeout: 30_000 });
        if (!response.ok()) return { outcome: "not_ready", remoteUrl: edit.directLink, reason: `Playback page HTTP ${response.status()}` };
        const html = await response.text();
        const master = html.match(/setVideoHLS\(['"]([^'"]+)['"]\)/)?.[1];
        if (!master) return { outcome: "not_ready", remoteUrl: edit.directLink, reason: "No HLS master advertised yet" };
        const url = new URL(master);
        if (url.protocol !== "https:" || !/(^|\.)xvideos(?:-cdn)?\.com$/.test(url.hostname)) {
            throw new Error("Unexpected provider playback manifest host");
        }
        const manifest = await page.request.get(url.href, { timeout: 30_000 });
        if (!manifest.ok()) throw new Error(`Playback manifest HTTP ${manifest.status()}`);
        const renditions = parsePlaybackRenditions(await manifest.text());
        return { outcome: hasFullHdPlayback(renditions) ? "online" : "not_ready",
            remoteUrl: edit.directLink, renditions,
            reason: hasFullHdPlayback(renditions) ? "Full-HD pixel tier available" : "Published, but Full-HD playback tier is missing" };
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
            ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
        }).catch((error: unknown) => {
            throw new HumanActionRequiredError("session_login",
                "Could not launch the XVideos browser profile. If an earlier run left a browser open, close it manually first. "
                + (error instanceof Error ? error.message : String(error)));
        });
        try {
            const page = context.pages()[0] ?? await context.newPage();
            await this.authenticateForUpload(page);
            return await run(page);
        } finally {
            await context.close();
        }
    }

    private async validateRequest(request: UploadRequest): Promise<void> {
        if (!request.recordingId.trim()) throw new Error("Upload request lacks a recording identity");
        if (!request.uploadIdentity.trim()) throw new Error("Upload request lacks a production upload identity");
        if (request.visibility !== "private") throw new Error("Only Direct-link XVideos uploads are supported");
        const artifactPath = path.resolve(request.artifactPath);
        await access(artifactPath);
        const stats = await stat(artifactPath);
        if (!stats.isFile() || stats.size !== request.sizeBytes) throw new Error("Upload artifact size no longer matches its ledger record");
        if (request.title.length > 255 || request.description.length > 1_000 || request.tags.length > 20) {
            throw new Error("Upload metadata exceeds XVideos limits");
        }
    }

    private async authenticateForUpload(page: Page): Promise<void> {
        try { await this.ensureAuthenticated(page); } catch (error) {
            if (error instanceof HumanActionRequiredError) throw error;
            // A redirect can remove the login form before an action completes.
            const ready = await this.verifyAccountDashboard(page.context()).catch(() => false);
            if (ready) return;
            throw new HumanActionRequiredError("session_login", error instanceof Error ? error.message : String(error));
        }
    }

    private async ensureAuthenticated(page: Page): Promise<void> {
        await page.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (await page.getByText("My Content", { exact: true }).count()) return;
        if (!await page.locator('form:has(input[type="password"])').isVisible().catch(() => false)) {
            const login = page.getByRole("link", { name: /^(?:log in|sign in)$/i });
            if (await login.count() === 1) await login.click();
        }
        await submitPasswordLogin(page, "https://www.xvideos.com", this.config);
        if (!await this.verifyAccountDashboard(page.context())) throw new HumanActionRequiredError(
            "session_login", "Native XVideos login did not reach the account dashboard; manual verification required");
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
        const startedAt = Date.now();
        const deadline = startedAt + 60_000;
        const elapsed = () => Math.round((Date.now() - startedAt) / 1000);
        let previousSolved = false;
        let lastProgressLoggedAt = 0;
        while (Date.now() < deadline) {
            if (await fileInput.count()) {
                console.log(JSON.stringify({ event: "friendly-captcha-complete", elapsedSeconds: elapsed() }));
                return;
            }
            // Hard stop: XVideos caps uploads per day. The form never appears
            // while the cap is in force, so detect the page message here.
            const limitNotice = page.getByText("uploaded too many videos", { exact: false });
            if (await limitNotice.count()) {
                throw new HumanActionRequiredError("daily_limit", "XVideos daily upload limit reached");
            }
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
                        console.log(JSON.stringify({ event: "friendly-captcha-widget-click", elapsedSeconds: elapsed() }));
                        await checkbox.click({ timeout: 5_000 }).catch(() => undefined);
                    }
                    const checked = await checkbox.getAttribute("aria-checked").catch(() => null);
                    widgetSolved = checked === "true" || stateClass.includes("state-completed");
                } catch {
                    // widget frame still mounting or detaching; retry next iteration
                }
            }
            if (widgetSolved && !previousSolved) {
                console.log(JSON.stringify({ event: "friendly-captcha-widget-solved", elapsedSeconds: elapsed() }));
            }
            previousSolved = widgetSolved;
            if (widgetSolved && await confirmButton.count() && await confirmButton.isEnabled()) {
                console.log(JSON.stringify({ event: "friendly-captcha-confirm-click", elapsedSeconds: elapsed() }));
                await confirmButton.click();
                await page.waitForTimeout(1_500);
                continue;
            }
            if (Date.now() - lastProgressLoggedAt >= 60_000) {
                lastProgressLoggedAt = Date.now();
                console.log(JSON.stringify({ event: "friendly-captcha-waiting", elapsedSeconds: elapsed(), widgetSolved }));
            }
            await page.waitForTimeout(750);
        }
        console.log(JSON.stringify({ event: "friendly-captcha-timeout", elapsedSeconds: elapsed() }));
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

    private async saveSubmissionEvidence(page: Page, request: UploadRequest, stage: string): Promise<void> {
        if (!request.onEvidence) return;
        // Only submission-page text, not login forms/cookies or signed media URLs.
        if (!page.url().startsWith(UPLOADS_URL)) return;
        const text = await page.locator("body").innerText().catch(() => "");
        await request.onEvidence({ stage, page: new URL(page.url()).pathname,
            text: text.slice(0, 16000),
            limitedVisibility: limitedVisibilityWarning(text),
            duplicateReported: /duplicate|already (?:been )?uploaded|already exists/i.test(text),
            rejectionReported: /upload failed|publication failed|video rejected|processing failed/i.test(text) });
    }

    private async captureSubmittedVideoId(page: Page, titleIdentity: string | null, request?: UploadRequest): Promise<string | null> {
        // After saving, XVideos first shows "Processing video 0% Publication:
        // pending" and only reveals the "edit it here" link once the panel
        // updates to "Video processed. Publication succeeded." (measured live:
        // ~20 seconds). Poll for the link instead of reading once.
        const deadline = Date.now() + 5 * 60_000;
        let lastEvidence = 0;
        while (Date.now() < deadline) {
            if (request && Date.now() - lastEvidence >= 30_000) {
                await this.saveSubmissionEvidence(page, request, "publication_wait");
                lastEvidence = Date.now();
            }
            const links = await page.locator('a[href*="/account/uploads/"]')
                .evaluateAll((elements) => elements.map((element) => element.getAttribute("href") ?? ""))
                .catch(() => [] as string[]);
            const currentId = submittedUploadEditId(page.url(), links);
            if (currentId) return currentId;
            await page.waitForTimeout(2_000);
        }
        // The exact filename suffix is stable even when the descriptive title changes.
        if (!titleIdentity) return null;
        // Legacy/comparison titles still carry an exact diagnostic identity.
        try {
            const entries = await this.findEntries(page, titleIdentity);
            const matching = entries.filter((entry) => hasDiagnosticUploadIdentity(entry.title, titleIdentity));
            if (matching.length === 1) return matching[0].remoteId;
        } catch {
            // list unreachable; manual review remains the last resort
        }
        return null;
    }

    async findEntries(page: Page, searchTerm: string): Promise<XvideosEntry[]> {
        // The uploads-list filter is a server-side search reachable directly
        // by URL (verified live: /account/uploads/f:t:<query>). One goto, no
        // selector dependencies.
        const searchUrl = `${UPLOADS_URL}/f:t:${encodeURIComponent(searchTerm)}`;
        const response = await page.goto(searchUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
        });
        if (!response?.ok() || new URL(page.url()).pathname !== new URL(searchUrl).pathname) {
            throw new Error("Uploads search failed or redirected; absence cannot be inferred");
        }
        if (!await page.getByText("My Content", { exact: true }).count()) {
            throw new HumanActionRequiredError("session_login", "Uploads search is not authenticated; absence cannot be inferred");
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
        const entries = filterXvideosEntries(candidates.map((candidate) => ({
            ...candidate,
            remoteUrl: candidate.remoteUrl ? new URL(candidate.remoteUrl, UPLOADS_URL).href : "",
        })), searchTerm);
        // Incomplete rows (e.g. still processing), pagination, or an unexpected
        // page must never be turned into a negative lookup and duplicate upload.
        if (entries.length !== candidates.length) throw new Error("Incomplete uploads search rows; absence cannot be inferred");
        if (await page.locator('a[rel="next"], .pagination a, .pagination button').count()) {
            throw new Error("Paginated uploads search requires manual review");
        }
        if (!entries.length && !/Your filters return no video\./i.test(await page.locator("body").innerText())) {
            throw new Error("Uploads search has no recognized empty result; absence cannot be inferred");
        }
        return entries;
    }

    async lookupUpload(page: Page, identity: string): Promise<
        { kind: "found"; remoteId: string; remoteUrl: string } | { kind: "absent" | "ambiguous" }
    > {
        const entries = await this.findEntries(page, identity.split(" | ")[0]);
        const matches = entries.filter(entry => hasDiagnosticUploadIdentity(entry.title, identity));
        if (matches.length === 1) return { kind: "found", ...matches[0] };
        // A related old-generation/partial title is not evidence of absence.
        return { kind: entries.length ? "ambiguous" : "absent" };
    }

    async recoverUploadId(page: Page, identity: string): Promise<string | null> {
        // Search by folder, then require an exact current-generation suffix.
        // Older generations and ambiguous matches are never adopted.
        const result = await this.lookupUpload(page, identity);
        return result.kind === "found" ? result.remoteId : null;
    }

    // Admission-time existence check: the folder name is the local truth, the
    // edit-page title is the XVideos truth. Runs in its own session for
    // remux-one/campaign intake, and inside the upload session as the backup.
    async findUploadedCopy(uploadIdentity: string): Promise<
        | { kind: "found"; remoteId: string; remoteUrl: string }
        | { kind: "title_mismatch"; remoteId: string }
        | { kind: "not_found" }
    > {
        return await this.withAuthenticatedPage((page) => this.findUploadedCopyOnPage(page, uploadIdentity));
    }

    async findUploadedCopyOnPage(page: Page, uploadIdentity: string): Promise<
        | { kind: "found"; remoteId: string; remoteUrl: string }
        | { kind: "title_mismatch"; remoteId: string }
        | { kind: "not_found" }
    > {
        const result = await this.lookupUpload(page, uploadIdentity);
        if (result.kind === "found") return result;
        if (result.kind === "ambiguous") throw new Error("Ambiguous existing uploads; refusing to upload again");
        return { kind: "not_found" };
    }
}

// An exact edit-page URL wins. A post-submit panel must expose a single unique
// edit ID; never attach an arbitrary first link when ownership is ambiguous.
export function submittedUploadEditId(currentUrl: string, links: readonly string[]): string | null {
    const parse = (raw: string): string | null => {
        try {
            const url = new URL(raw, UPLOADS_URL);
            if (url.origin !== new URL(UPLOADS_URL).origin) return null;
            return url.pathname.match(/^\/account\/uploads\/(\d+)\/edit\/?$/)?.[1] ?? null;
        } catch { return null; }
    };
    const current = parse(currentUrl);
    if (current) return current;
    const ids = [...new Set(links.map(parse).filter((id): id is string => id !== null))];
    return ids.length === 1 ? ids[0] : null;
}
