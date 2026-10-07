import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Page, type Request } from "playwright";
import { HumanActionRequiredError, type ChromiumUploaderConfig } from "./chromiumXvideosUploader.js";
import { submitPasswordLogin } from "./passwordLogin.js";
import { hasDiagnosticUploadIdentity } from "../metadata/composeUploadMetadata.js";
import type { UploadOutcome, UploadRequest, XvideosUploader } from "./disabledXvideosUploader.js";
import { hasFullHdPlayback } from "./playbackQuality.js";
import { ProviderSessionLostError, SESSION_LOST_ADVICE, TransferAbortedBeforeSubmissionError } from "./providerWarnings.js";
import { parsePorntrexEditPage, porntrexUploadsPagePath, type StoredPorntrexMetadata } from "./porntrexMetadata.js";
import {
    PORNTREX_LOGIN_TOKEN, pinCookies, readPorntrexSession, sessionFingerprint, sharedSessionCookies, writePorntrexSession,
    type PorntrexSession,
} from "./porntrexSession.js";

const ORIGIN = "https://www.porntrex.com";
const LIST = "#list_videos_my_uploaded_videos";
const PORNTREX_UPLOADS_PAGE_ROWS = 30;
const run = promisify(execFile);
// The page uploads in 9 MB chunks and shows a percentage. A transfer is only
// given up when that percentage has not moved for this long.
const TRANSFER_STALL_MILLISECONDS = 10 * 60_000;
type Entry = { remoteId: string; remoteUrl: string; title: string };

export function matchesPorntrexIdentity(title: string, identity: string): boolean {
    // Also recognize the user's existing manually uploaded, unbracketed filenames.
    return hasDiagnosticUploadIdentity(title, identity) || title.trimEnd().endsWith(` ${identity}`);
}

// The site's 18+ notice returns whenever its weekly "confirmed" cookie expires.
// It is the only overlay answered automatically; anything else needs a person.
export async function passPorntrexAgeGate(page: Page): Promise<void> {
    const overlay = page.locator("#overlay");
    if (!await overlay.isVisible().catch(() => false)) return;
    const confirm = overlay.locator("#okButton");
    if (await confirm.count() !== 1 || !/^\s*i'?m 18 or older\s*$/i.test(await confirm.textContent() ?? "")) {
        throw new HumanActionRequiredError("session_login", "Complete the first-visit Porntrex prompts in the persistent browser profile");
    }
    await confirm.click();
    await overlay.waitFor({ state: "hidden", timeout: 10_000 });
}

// Every MP4 download link, highest labelled tier first. The label is only an
// ordering hint (portrait videos may be labelled by their long side); the
// probed stream's pixels decide Full HD.
export function orderPlaybackCandidates(rows: ReadonlyArray<{ url: string; label: string }>): Array<{ url: string; label: string }> {
    const tier = (label: string) => Number(label.match(/(\d{3,4})p\b/)?.[1] ?? 0);
    return [...new Map(rows.filter((row) => row.url).map((row) => [row.url, row])).values()]
        .sort((left, right) => tier(right.label) - tier(left.label));
}

// Exactly the upload page's chunk POSTs. Analytics pixels and other requests
// can carry the upload address inside their own query strings.
export function isPorntrexChunkRequest(method: string, rawUrl: string): boolean {
    if (method !== "POST") return false;
    const url = new URL(rawUrl);
    return url.origin === ORIGIN && url.pathname === "/upload-video/"
        && url.searchParams.get("mode") === "async" && url.searchParams.get("action") === "upload_file";
}

export class ChromiumPorntrexUploader implements XvideosUploader {
    readonly provider = "porntrex" as const;
    constructor(private readonly config: ChromiumUploaderConfig) {}

    // Opens the shared session. A password login happens only when explicitly
    // allowed (the connect command): it would log the phone out. Otherwise a
    // missing login means another device took it, and the run stops.
    async withAuthenticatedPage<T>(action: (page: Page) => Promise<T>, options: { allowPasswordLogin?: boolean } = {}): Promise<T> {
        const context = await chromium.launchPersistentContext(this.config.profilePath, {
            executablePath: this.config.executablePath,
            headless: this.config.headless ?? false,
            viewport: null,
            args: ["--disable-blink-features=AutomationControlled"],
            ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
        }).catch(() => { throw new HumanActionRequiredError("session_login", "Could not open the Porntrex browser profile; close its manual browser first"); });
        try {
            const stored = this.config.sessionFilePath ? await readPorntrexSession(this.config.sessionFilePath) : null;
            // kt_member would sign in a new session and log the phone out; the
            // shared PHP session is the only login the pipeline may present.
            await context.clearCookies({ name: PORNTREX_LOGIN_TOKEN });
            if (stored) await context.addCookies(pinCookies(stored.cookies));
            const page = context.pages()[0] ?? await context.newPage();
            await page.goto(`${ORIGIN}/upload-video/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await passPorntrexAgeGate(page);
            const file = page.locator('input[type="file"][name="content"]');
            let passwordLoginAt: string | null = null;
            if (!await file.count()) {
                if (!options.allowPasswordLogin) {
                    throw new ProviderSessionLostError(`Porntrex is not logged in with the shared session (another device logged in, or it ended); ${SESSION_LOST_ADVICE}`);
                }
                await page.goto(`${ORIGIN}/login/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
                await passPorntrexAgeGate(page);
                await page.locator('form input[name="pass"]').last().waitFor({ state: "visible", timeout: 15_000 });
                await submitPasswordLogin(page, ORIGIN, this.config);
                await page.getByRole("link", { name: /Hello,/ }).first().waitFor({ state: "visible", timeout: 30_000 });
                passwordLoginAt = new Date().toISOString();
                await context.clearCookies({ name: PORNTREX_LOGIN_TOKEN });
                await page.goto(`${ORIGIN}/upload-video/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
            }
            await file.waitFor({ state: "attached", timeout: 15_000 });
            await this.saveSharedSession(context, stored, passwordLoginAt);
            return await action(page);
        } finally { await context.close(); }
    }

    // Pin the session in the profile and the file so no later launch starts a
    // new one. A changed PHP session ID (server rotation) is recorded as is.
    private async saveSharedSession(context: BrowserContext, stored: PorntrexSession | null, passwordLoginAt: string | null): Promise<void> {
        if (!this.config.sessionFilePath) return;
        const now = new Date();
        const cookies = pinCookies(sharedSessionCookies((await context.cookies(ORIGIN)) as never), now);
        if (!sessionFingerprint(cookies)) throw new Error("Porntrex is logged in without a PHP session cookie; refusing to guess");
        await context.addCookies(cookies);
        await writePorntrexSession(this.config.sessionFilePath, {
            version: 1,
            cookies,
            passwordLoginAt: passwordLoginAt ?? stored?.passwordLoginAt ?? now.toISOString(),
            savedAt: now.toISOString(),
        });
    }

    // Same-session request from inside the page: is the login still ours?
    private async stillLoggedIn(page: Page): Promise<boolean> {
        return await page.evaluate(async () => {
            const response = await fetch("/upload-video/", { credentials: "include" });
            return /name="content"/.test(await response.text());
        }).catch(() => true);
    }

    async lookupUpload(page: Page, identity: string): Promise<
        { kind: "found"; remoteId: string; remoteUrl: string } | { kind: "absent" | "ambiguous" }
    > {
        await page.goto(`${ORIGIN}/my/videos/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await passPorntrexAgeGate(page);
        const entries = new Map<string, Entry>();
        const processing = new Set<string>();
        const failed = new Set<string>();
        let listEnded = false;
        let countsProcessing = false;
        const signatures = new Set<string>();
        let expected = -1;
        for (let pageNumber = 1; pageNumber <= 1000; pageNumber++) {
            await page.locator(LIST).waitFor({ state: "visible", timeout: 15_000 });
            const snapshot = await page.locator(LIST).evaluate(container => ({
                heading: container.querySelector("h2")?.textContent ?? "",
                // "Public (N)" / "Private (M)": the real totals, processing rows
                // included. The heading's count lags and was seen stuck at 2.
                tabs: [...container.querySelectorAll('a[data-parameters^="is_private:"]')].map(tab => tab.textContent ?? ""),
                rows: [...container.querySelectorAll("[data-item-id]")].map(row => {
                    const title = row.querySelector("p.inf a");
                    // A just-uploaded video is listed as "Processing..." with an
                    // empty link and is not yet part of the heading's count.
                    return { remoteId: row.getAttribute("data-item-id") ?? "", title: title?.textContent?.trim() ?? "",
                        remoteUrl: title?.getAttribute("href") ?? "",
                        processing: row.classList.contains("processing") || !!row.querySelector(".line-processing"),
                        // Porntrex's own processing failed: an "Error" badge, no
                        // link, Edit disabled. Counted in the totals.
                        failed: row.classList.contains("error") || !!row.querySelector(".line-error") };
                }),
            }));
            const tabTotals = snapshot.tabs.map(tab => Number(tab.match(/\((\d+)\)/)?.[1] ?? NaN));
            const fromTabs = tabTotals.length > 0 && tabTotals.every(Number.isSafeInteger);
            expected = fromTabs ? tabTotals.reduce((sum, count) => sum + count, 0)
                : Number(snapshot.heading.match(/My Videos\s*\((\d+)\)/i)?.[1] ?? NaN);
            if (!Number.isSafeInteger(expected)) throw new Error("Porntrex uploads list has no recognized total; cannot infer absence");
            countsProcessing = fromTabs;
            for (const row of snapshot.rows) {
                const published = row.remoteUrl.startsWith(`${ORIGIN}/video/${row.remoteId}/`);
                const unlinked = (row.processing || row.failed) && row.remoteUrl === "";
                if (!/^\d+$/.test(row.remoteId) || !row.title || (!published && !unlinked)) {
                    throw new Error("Incomplete Porntrex upload row; cannot infer absence");
                }
                if (row.processing) processing.add(row.remoteId);
                if (row.failed && !published) failed.add(row.remoteId);
                entries.set(row.remoteId, { remoteId: row.remoteId, title: row.title,
                    remoteUrl: published ? row.remoteUrl : `${ORIGIN}/video/${row.remoteId}/` });
            }
            const signature = snapshot.rows.map(row => row.remoteId).join(",");
            if (signatures.has(signature)) throw new Error("Porntrex pagination did not advance; cannot infer absence");
            signatures.add(signature);
            if (entries.size - (countsProcessing ? 0 : processing.size) === expected) break;
            // Load the next page of the list directly (30 rows per page).
            const nextPagePath = `${ORIGIN}${porntrexUploadsPagePath(pageNumber + 1)}`;
            let nextPage = await page.goto(nextPagePath, { waitUntil: "domcontentloaded", timeout: 30_000 });
            // Past the last page Porntrex answers 404. Its tab totals still count
            // a video it has removed (61 counted, 60 listed, the 61st's edit page
            // 404), so after a full page a repeated 404 ends the list even short
            // of the total; a single 404 could be transient and is asked again.
            if (nextPage?.status() === 404 && snapshot.rows.length >= PORNTREX_UPLOADS_PAGE_ROWS
                && entries.size <= expected) {
                await page.waitForTimeout(2_000);
                nextPage = await page.goto(nextPagePath, { waitUntil: "domcontentloaded", timeout: 30_000 });
                if (nextPage?.status() === 404) { listEnded = true; break; }
            }
            if (!nextPage?.ok()) throw new Error("Porntrex uploads list is incomplete; cannot infer absence");
        }
        if (!listEnded && entries.size - (countsProcessing ? 0 : processing.size) !== expected) throw new Error("Porntrex uploads list scan was incomplete");
        // A failed upload holds no video: it is no copy of the recording.
        const matches = [...entries.values()].filter(row => !failed.has(row.remoteId) && matchesPorntrexIdentity(row.title, identity));
        return matches.length === 1 ? { kind: "found", ...matches[0] }
            : { kind: matches.length > 1 ? "ambiguous" : "absent" };
    }

    async findUploadedCopy(identity: string): Promise<{ kind: "found"; remoteId: string; remoteUrl: string } | { kind: "not_found" }> {
        return await this.withAuthenticatedPage(async page => {
            const match = await this.lookupUpload(page, identity);
            if (match.kind === "ambiguous") throw new Error("Ambiguous Porntrex filename match; refusing another upload");
            return match.kind === "found" ? match : { kind: "not_found" };
        });
    }

    async upload(request: UploadRequest): Promise<UploadOutcome> {
        if (request.visibility !== "public") throw new Error("Only user-approved public Porntrex uploads are configured");
        if (request.sizeBytes > 10_000_000_000) throw new Error("porntrex: blocked_too_large; maximum 10000000000 bytes; manual review required");
        const file = await stat(request.artifactPath);
        if (!file.isFile() || file.size !== request.sizeBytes) throw new Error("Upload artifact no longer matches its ledger record");
        const identity = hasDiagnosticUploadIdentity(request.title, request.uploadIdentity) ? request.uploadIdentity
            : request.title.match(/\[([^\[\]]+)\]\s*$/)?.[1];
        if (!identity) throw new Error("Porntrex upload lacks an exact filename identity");
        return await this.withAuthenticatedPage(async page => {
            const match = await this.lookupUpload(page, identity);
            if (match.kind === "found") return { kind: "existing", remoteId: match.remoteId, remoteUrl: match.remoteUrl };
            if (match.kind !== "absent") throw new Error("Ambiguous Porntrex upload identity; refusing duplicate");
            await page.goto(`${ORIGIN}/upload-video/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await passPorntrexAgeGate(page);
            const upload = page.locator('form:has(input[type="file"][name="content"])');
            await upload.waitFor({ state: "visible", timeout: 15_000 });
            await page.locator("#edit_video_upload_option_file").check();
            // Persist transfer intent BEFORE choosing a file: some uploaders start on selection.
            await request.onProgress?.("file_uploading", request.sizeBytes);
            await upload.locator('input[name="content"]').setInputFiles(request.artifactPath);
            await upload.locator('input[type="submit"]').click();
            await this.waitForFileTransfer(page, request);
            await request.onProgress?.("file_uploaded", request.sizeBytes);
            const metadata = page.locator("form:has(#edit_video_title)");
            if (request.title.length > 300) throw new Error("Porntrex title exceeds 300 characters");
            await page.locator("#edit_video_title").fill(request.title);
            await page.locator("#edit_video_description").fill(request.description);
            await page.locator("#edit_video_tags").fill(request.tags.join(", "));
            await page.locator("#edit_video_categories").click();
            // Categories open in a popup whose checkboxes are styled hidden;
            // the labels are the clickable part. A click outside closes it, and
            // until then it covers the form fields below it.
            const webcam = page.locator('label[for="category_21"]'); // Observed Webcam category.
            await webcam.waitFor({ state: "visible", timeout: 15_000 });
            if (!await page.locator("#category_21").isChecked()) await webcam.click();
            // Only a real click outside closes it (verified on the live form): the
            // inert "Video Info" heading, or the page corner if that is covered.
            await page.locator("p.section-title").first().click({ timeout: 5_000 }).catch(() => page.mouse.click(5, 5));
            await webcam.waitFor({ state: "hidden", timeout: 10_000 });
            if (!await metadata.locator('input[name="category_ids[]"][value="21"]').count()) {
                throw new Error("Porntrex Webcam category was not applied; metadata not submitted");
            }
            await request.onProgress?.("metadata_submitting", request.sizeBytes);
            await request.onEvidence?.({ stage: "metadata_prepared", provider: this.provider, visibility: "public" });
            const submittedAt = new Date();
            await metadata.locator('input[type="submit"]').click();
            // Do not equate a submit click with acceptance. Store uncertainty and verify later.
            // The new video is listed (as processing) within moments; give it a
            // minute so its ID is captured now rather than recovered tomorrow.
            let remoteId: string | null = null;
            for (let attempt = 0; attempt < 5 && !remoteId; attempt++) {
                if (attempt) await page.waitForTimeout(15_000);
                const recovered = await this.lookupUpload(page, identity).catch(() => ({ kind: "absent" as const }));
                remoteId = recovered.kind === "found" ? recovered.remoteId : null;
            }
            if (remoteId) await request.onEvidence?.({ stage: "remote_identity_captured", remoteId });
            return { kind: "uploaded", receipt: { transmittedBytes: request.sizeBytes,
                submittedVideoId: remoteId, metadataSubmittedAt: submittedAt.toISOString() } };
        });
    }

    // Follow the page's own progress bar, like a person watching the upload:
    // keep waiting while it moves, however slow the connection is, and stop
    // only on a stall or a page error. The metadata form marks completion.
    private async waitForFileTransfer(page: Page, request: UploadRequest): Promise<void> {
        const title = page.locator("#edit_video_title");
        let percent = -1;
        let movedAt = Date.now();
        // The page retries a chunk silently on network errors, so keep what
        // its chunk requests actually got back: a stall must say why.
        const chunkProblems: string[] = [];
        const isChunk = (request: Request) => isPorntrexChunkRequest(request.method(), request.url());
        page.on("requestfailed", (failed) => {
            if (isChunk(failed)) chunkProblems.push(`failed: ${failed.failure()?.errorText ?? "unknown"}`);
        });
        page.on("response", (response) => {
            if (!isChunk(response.request())) return;
            if (response.status() >= 300) chunkProblems.push(`HTTP ${response.status()} ${response.headers()["content-type"] ?? ""}`);
        });
        // A chunk answered with anything but the site's success JSON (a login
        // redirect, an error page) ends the transfer: the page stops there.
        let chunkRejected: string | null = null;
        page.on("response", (response) => {
            let first = response.request();
            while (first.redirectedFrom()) first = first.redirectedFrom()!;
            if (!isChunk(first)) return;
            if (first !== response.request()) { chunkRejected = `redirected to ${new URL(response.url()).pathname}`; return; }
            void response.text().then((body) => {
                let status: unknown;
                try { status = (JSON.parse(body) as { status?: unknown }).status; } catch { status = "not JSON"; }
                if (status !== "success") {
                    chunkRejected = `chunk response ${String(status)} (HTTP ${response.status()} ${response.headers()["content-type"] ?? ""})`;
                }
            }).catch(() => undefined);
        });
        const stalled = async (message: string) => {
            await request.onEvidence?.({ stage: "transfer_stall", percent, chunkProblems: chunkProblems.slice(-10),
                page: new URL(page.url()).pathname, loggedIn: await page.getByRole("link", { name: /Hello,/ }).count() > 0 });
            return new TransferAbortedBeforeSubmissionError(
                `${message}${chunkProblems.length ? `; chunk responses: ${chunkProblems.slice(-3).join(" | ")}` : ""}`);
        };
        for (;;) {
            if (await title.isVisible().catch(() => false)) {
                console.log(JSON.stringify({ event: "porntrex-transfer-complete" }));
                return;
            }
            const error = (await page.locator(".form-upload .generic-error:visible").first().textContent({ timeout: 1_000 })
                .catch(() => null))?.trim();
            if (error || chunkRejected) {
                if (!await this.stillLoggedIn(page)) {
                    await stalled("session lost");
                    throw new ProviderSessionLostError(`Porntrex logged this session out during the upload (another device logged in); ${SESSION_LOST_ADVICE}`);
                }
                throw await stalled(`Porntrex upload ${error ? `page error: ${error}` : chunkRejected}`);
            }
            const text = await page.locator(".form-upload .progressbar .text").first().textContent({ timeout: 1_000 }).catch(() => null);
            const current = text ? Number.parseInt(text, 10) : Number.NaN;
            // Progress is not logged: a transfer that stops moving fails after
            // TRANSFER_STALL_MILLISECONDS, and the step logs the outcome.
            if (Number.isFinite(current) && current > percent) {
                percent = current;
                movedAt = Date.now();
            }
            if (Date.now() - movedAt > TRANSFER_STALL_MILLISECONDS) {
                if (!await this.stillLoggedIn(page)) {
                    await stalled("session lost");
                    throw new ProviderSessionLostError(`Porntrex logged this session out during the upload (another device logged in); ${SESSION_LOST_ADVICE}`);
                }
                throw await stalled(`Porntrex file transfer made no progress for ${TRANSFER_STALL_MILLISECONDS / 60_000} minutes (last ${percent}%)`);
            }
            await page.waitForTimeout(15_000);
        }
    }

    // Whether My Videos lists the upload with Porntrex's "Error" badge (its own
    // processing failed). Pages are read until the row is found or the list ends.
    private async listedAsFailed(page: Page, uploadId: string): Promise<boolean> {
        for (let pageNumber = 1; pageNumber <= 1000; pageNumber++) {
            const response = await page.goto(`${ORIGIN}${pageNumber === 1 ? "/my/videos/" : porntrexUploadsPagePath(pageNumber)}`,
                { waitUntil: "domcontentloaded", timeout: 30_000 });
            if (pageNumber === 1) await passPorntrexAgeGate(page);
            if (!response?.ok() || await page.locator("[data-item-id]").count() === 0) return false;
            const row = page.locator(`[data-item-id="${uploadId}"]`);
            if (await row.count()) {
                return await row.first().evaluate(item => item.classList.contains("error") || !!item.querySelector(".line-error"));
            }
        }
        return false;
    }

    async probeUploadStatus(page: Page, uploadId: string) {
        if (!/^\d+$/.test(uploadId)) throw new Error("Invalid Porntrex edit ID");
        const response = await page.goto(`${ORIGIN}/edit-video/${uploadId}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (response?.status() === 404) {
            // Porntrex also 404s the edit page while a new video is processing.
            // Only an ID absent from the uploads list is really gone.
            await page.goto(`${ORIGIN}/my/videos/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
            await passPorntrexAgeGate(page);
            await page.locator(LIST).waitFor({ state: "visible", timeout: 15_000 });
            if (await page.locator(`${LIST} [data-item-id="${uploadId}"]`).count()) {
                return { outcome: "not_ready" as const, remoteUrl: null, reason: "Porntrex is still processing the video", processing: true };
            }
            return { outcome: "missing" as const, remoteUrl: null, reason: "Porntrex edit page returned 404 and the uploads list does not contain it" };
        }
        if (!response?.ok()) return { outcome: "not_ready" as const, remoteUrl: null, reason: "Porntrex edit page is not available" };
        // What Porntrex stored, for the caller to compare with what we sent.
        const stored: StoredPorntrexMetadata | null = parsePorntrexEditPage(await page.content());
        const link = page.locator(`a[href^="${ORIGIN}/video/${uploadId}/"]`).first();
        const remoteUrl = await link.getAttribute("href");
        if (!remoteUrl) {
            // Checked a day after submission. Porntrex's "Error" can clear (a
            // failed upload was published about ten hours later), but one that
            // still stands after a day is blocked for review, not re-uploaded:
            // the same file may fail again, and an Error row cannot be deleted.
            if (await this.listedAsFailed(page, uploadId)) {
                return { outcome: "missing" as const, remoteUrl: null, stored,
                    reason: "Porntrex still marks the upload \"Error\" in My Videos a day after submission; no video is published. Review the artifact before `npm run retry`" };
            }
            return { outcome: "not_ready" as const, remoteUrl: null, reason: "Porntrex has no published video link yet", stored };
        }
        await page.goto(remoteUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const candidates = orderPlaybackCandidates(await page.locator('a[href*="/get_file/"]').evaluateAll(links => links.map(link => ({
            url: link.getAttribute("href") ?? "", label: link.textContent?.trim() ?? "",
        }))));
        const renditions: Array<{ width: number; height: number; label: string }> = [];
        let failures = 0;
        for (const candidate of candidates) {
            const url = new URL(candidate.url, ORIGIN);
            if (url.origin !== ORIGIN || !url.pathname.startsWith("/get_file/")) throw new Error("Unexpected Porntrex playback URL");
            // A quality label is not proof of dimensions. Probe stream headers, not the whole video.
            let output;
            try {
                output = await run("ffprobe", ["-v", "error", "-rw_timeout", "15000000", "-probesize", "2000000",
                    "-analyzeduration", "2000000", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", url.href],
                { timeout: 25_000, maxBuffer: 64 * 1024 });
            } catch {
                // One link failing (the CDN does this now and then) says nothing about the others.
                failures++;
                continue;
            }
            const stream = (JSON.parse(output.stdout) as { streams: Array<{ width: number; height: number }> }).streams?.[0];
            if (!stream) continue;
            renditions.push({ ...stream, label: candidate.label });
            if (hasFullHdPlayback([{ ...stream, label: candidate.label }])) return { outcome: "online" as const, remoteUrl, renditions, reason: "Full-HD pixel tier verified from playback stream", stored };
        }
        if (!renditions.length && failures) throw new Error("Porntrex playback dimension probe failed; retry verification, not upload");
        const best = [...renditions].sort((left, right) => right.width * right.height - left.width * left.height)[0];
        return { outcome: "not_ready" as const, remoteUrl, renditions, stored,
            reason: best ? `Published; best stream ${best.width}x${best.height} (${best.label}), no Full-HD tier yet` : "Published, but no playback stream was found" };
    }
}
