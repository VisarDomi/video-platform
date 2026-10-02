import { stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chromium, type Page } from "playwright";
import { HumanActionRequiredError, type ChromiumUploaderConfig } from "./chromiumXvideosUploader.js";
import { submitPasswordLogin } from "./passwordLogin.js";
import { hasDiagnosticUploadIdentity } from "../metadata/composeUploadMetadata.js";
import type { UploadOutcome, UploadRequest, XvideosUploader } from "./disabledXvideosUploader.js";
import { hasFullHdPlayback } from "./playbackQuality.js";

const ORIGIN = "https://www.porntrex.com";
const LIST = "#list_videos_my_uploaded_videos";
const run = promisify(execFile);
type Entry = { remoteId: string; remoteUrl: string; title: string };

export function matchesPorntrexIdentity(title: string, identity: string): boolean {
    // Also recognize the user's existing manually uploaded, unbracketed filenames.
    return hasDiagnosticUploadIdentity(title, identity) || title.trimEnd().endsWith(` ${identity}`);
}

export class ChromiumPorntrexUploader implements XvideosUploader {
    readonly provider = "porntrex" as const;
    constructor(private readonly config: ChromiumUploaderConfig) {}

    async withAuthenticatedPage<T>(action: (page: Page) => Promise<T>): Promise<T> {
        const context = await chromium.launchPersistentContext(this.config.profilePath, {
            executablePath: this.config.executablePath,
            headless: this.config.headless ?? false,
            viewport: null,
            args: ["--disable-blink-features=AutomationControlled"],
            ignoreDefaultArgs: ["--enable-automation", "--disable-extensions"],
        }).catch(() => { throw new HumanActionRequiredError("session_login", "Could not open the Porntrex browser profile; close its manual browser first"); });
        try {
            const page = context.pages()[0] ?? await context.newPage();
            await page.goto(`${ORIGIN}/upload-video/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
            const file = page.locator('input[type="file"][name="content"]');
            if (!await file.count()) {
                await page.goto(`${ORIGIN}/login/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
                if (await page.locator("#overlay").isVisible().catch(() => false)) {
                    throw new HumanActionRequiredError("session_login", "Complete the first-visit Porntrex prompts in the persistent browser profile");
                }
                await page.locator('form input[name="pass"]').last().waitFor({ state: "visible", timeout: 15_000 });
                await submitPasswordLogin(page, ORIGIN, this.config);
                await page.getByRole("link", { name: /Hello,/ }).first().waitFor({ state: "visible", timeout: 30_000 });
                await page.goto(`${ORIGIN}/upload-video/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
            }
            await file.waitFor({ state: "attached", timeout: 15_000 });
            return await action(page);
        } finally { await context.close(); }
    }

    async lookupUpload(page: Page, identity: string): Promise<
        { kind: "found"; remoteId: string; remoteUrl: string } | { kind: "absent" | "ambiguous" }
    > {
        await page.goto(`${ORIGIN}/my/videos/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const entries = new Map<string, Entry>();
        const signatures = new Set<string>();
        let expected = -1;
        for (let pageNumber = 1; pageNumber <= 1000; pageNumber++) {
            await page.locator(LIST).waitFor({ state: "visible", timeout: 15_000 });
            const snapshot = await page.locator(LIST).evaluate(container => ({
                heading: container.querySelector("h2")?.textContent ?? "",
                rows: [...container.querySelectorAll("[data-item-id]")].map(row => {
                    const title = row.querySelector('p.inf a[href*="/video/"]');
                    return { remoteId: row.getAttribute("data-item-id") ?? "", title: title?.textContent?.trim() ?? "",
                        remoteUrl: title?.getAttribute("href") ?? "" };
                }),
            }));
            expected = Number(snapshot.heading.match(/My Videos\s*\((\d+)\)/i)?.[1] ?? NaN);
            if (!Number.isSafeInteger(expected)) throw new Error("Porntrex uploads list has no recognized total; cannot infer absence");
            for (const row of snapshot.rows) {
                if (!/^\d+$/.test(row.remoteId) || !row.title || !row.remoteUrl.startsWith(`${ORIGIN}/video/${row.remoteId}/`)) {
                    throw new Error("Incomplete Porntrex upload row; cannot infer absence");
                }
                entries.set(row.remoteId, row);
            }
            const signature = snapshot.rows.map(row => row.remoteId).join(",");
            if (signatures.has(signature)) throw new Error("Porntrex pagination did not advance; cannot infer absence");
            signatures.add(signature);
            if (entries.size === expected) break;
            const next = page.locator(`${LIST} .pagination`).getByRole("link", { name: /^(?:next(?:\s+page)?(?:\s*[›»>])?|[›»>])$/i });
            const numbered = page.locator(`${LIST} .pagination`).getByRole("link", { name: new RegExp(`^0*${pageNumber + 1}$`) });
            const control = await next.count() === 1 ? next : numbered;
            if (await control.count() !== 1) throw new Error("Porntrex uploads list is incomplete; cannot infer absence");
            await control.click();
            await page.locator(`${LIST} [data-item-id="${snapshot.rows[0]?.remoteId}"]`)
                .waitFor({ state: "detached", timeout: 15_000 });
        }
        if (entries.size !== expected) throw new Error("Porntrex uploads list scan was incomplete");
        const matches = [...entries.values()].filter(row => matchesPorntrexIdentity(row.title, identity));
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
            const upload = page.locator('form:has(input[type="file"][name="content"])');
            await upload.waitFor({ state: "visible", timeout: 15_000 });
            await page.locator("#edit_video_upload_option_file").check();
            // Persist transfer intent BEFORE choosing a file: some uploaders start on selection.
            await request.onProgress?.("file_uploading", request.sizeBytes);
            await upload.locator('input[name="content"]').setInputFiles(request.artifactPath);
            await upload.locator('input[type="submit"]').click();
            await page.locator("#edit_video_title").waitFor({ state: "visible", timeout: 30 * 60_000 });
            await request.onProgress?.("file_uploaded", request.sizeBytes);
            const metadata = page.locator("form:has(#edit_video_title)");
            if (request.title.length > 300) throw new Error("Porntrex title exceeds 300 characters");
            await page.locator("#edit_video_title").fill(request.title);
            await page.locator("#edit_video_description").fill(request.description);
            await page.locator("#edit_video_tags").fill(request.tags.join(", "));
            await page.locator("#edit_video_categories").click();
            await page.locator('input[type="checkbox"][value="21"]').check(); // Observed Webcam category.
            await page.locator("#edit_video_title").click();
            if (!await metadata.locator('input[name="category_ids[]"][value="21"]').count()) {
                throw new Error("Porntrex Webcam category was not applied; metadata not submitted");
            }
            await request.onProgress?.("metadata_submitting", request.sizeBytes);
            await request.onEvidence?.({ stage: "metadata_prepared", provider: this.provider, visibility: "public" });
            const submittedAt = new Date();
            await metadata.locator('input[type="submit"]').click();
            // Do not equate a submit click with acceptance. Store uncertainty and verify later.
            const recovered = await this.lookupUpload(page, identity);
            const remoteId = recovered.kind === "found" ? recovered.remoteId : null;
            if (remoteId) await request.onEvidence?.({ stage: "remote_identity_captured", remoteId });
            return { kind: "uploaded", receipt: { transmittedBytes: request.sizeBytes,
                submittedVideoId: remoteId, metadataSubmittedAt: submittedAt.toISOString() } };
        });
    }

    async probeUploadStatus(page: Page, uploadId: string) {
        if (!/^\d+$/.test(uploadId)) throw new Error("Invalid Porntrex edit ID");
        const response = await page.goto(`${ORIGIN}/edit-video/${uploadId}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (!response?.ok()) return { outcome: "not_ready" as const, remoteUrl: null, reason: "Porntrex edit page is not available" };
        const link = page.locator(`a[href^="${ORIGIN}/video/${uploadId}/"]`).first();
        const remoteUrl = await link.getAttribute("href");
        if (!remoteUrl) return { outcome: "not_ready" as const, remoteUrl: null, reason: "Porntrex has no published video link yet" };
        await page.goto(remoteUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const candidates = await page.locator('a[href*="/get_file/"]').evaluateAll(links => links.map(link => ({
            url: link.getAttribute("href") ?? "", label: link.textContent?.trim() ?? "",
        }))).then(rows => rows.filter(row => /\b(?:1080|1440|2160)p\b/.test(row.label)));
        for (const candidate of candidates) {
            const url = new URL(candidate.url, ORIGIN);
            if (url.origin !== ORIGIN || !url.pathname.startsWith("/get_file/")) throw new Error("Unexpected Porntrex playback URL");
            // A quality label is not proof of dimensions. Probe stream headers, not the whole video.
            let output;
            try {
                output = await run("ffprobe", ["-v", "error", "-rw_timeout", "15000000", "-probesize", "2000000",
                    "-analyzeduration", "2000000", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", url.href],
                { timeout: 25_000, maxBuffer: 64 * 1024 });
            } catch { throw new Error("Porntrex playback dimension probe failed; retry verification, not upload"); }
            const stream = (JSON.parse(output.stdout) as { streams: Array<{ width: number; height: number }> }).streams?.[0];
            const renditions = stream ? [{ ...stream, label: candidate.label }] : [];
            if (hasFullHdPlayback(renditions)) return { outcome: "online" as const, remoteUrl, renditions, reason: "Full-HD pixel tier verified from playback stream" };
        }
        return { outcome: "not_ready" as const, remoteUrl, reason: "Published, but Full-HD playback dimensions are not confirmed" };
    }
}
