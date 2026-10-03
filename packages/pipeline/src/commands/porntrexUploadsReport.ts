import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { porntrexGet } from "../upload/porntrexKeepalive.js";
import { comparePorntrexMetadata, parsePorntrexEditPage, parsePorntrexUploadsList, porntrexUploadsPagePath, type ListedPorntrexUpload } from "../upload/porntrexMetadata.js";
import { matchesPorntrexIdentity } from "../upload/chromiumPorntrexUploader.js";
import { readPorntrexSession, sessionFingerprint } from "../upload/porntrexSession.js";

const hoursSince = (iso: string, now: Date) => Math.round((now.getTime() - Date.parse(iso)) / 36e5 * 10) / 10;

// `npm run ptrex:uploads`: what Porntrex shows for the pipeline's uploads, read
// on the shared session (no login, so the phone and pipeline stay signed in).
// New videos stay "Processing..." for up to about a day; once published, the
// stored title, description, tags and category are compared with the ledger.
export async function porntrexUploadsReport(config: PipelineConfig, limit = 25, now = new Date(), get = porntrexGet): Promise<unknown> {
    const sessionFile = config.porntrexSessionPath;
    if (!sessionFile) throw new Error("No Porntrex session file is configured");
    const session = await readPorntrexSession(sessionFile);
    const database = new PipelineDatabase(config.databasePath);
    try {
        const uploads = database.listPorntrexUploads(limit);
        const list = await get(sessionFile, "/my/videos/");
        if (list.status !== 200) throw new Error(`The shared session is not logged in (My Videos answered ${list.status}); run \`npm run ptrex:connect-iphone\``);
        const listed: ListedPorntrexUpload[] = parsePorntrexUploadsList(list.html);
        // Every further page (30 per page) until the site has no more.
        for (let pageNumber = 2; pageNumber <= 1000; pageNumber++) {
            const next = await get(sessionFile, porntrexUploadsPagePath(pageNumber));
            const rows = next.status === 200 ? parsePorntrexUploadsList(next.html).filter((row) => !listed.some((seen) => seen.remoteId === row.remoteId)) : [];
            if (!rows.length) break;
            listed.push(...rows);
        }
        const rows: Array<{
            recording: string; remoteId: string | null; uploadedHoursAgo: number; porntrex: string;
            titleListed: boolean | null; metadata: unknown; pipeline: string;
        }> = [];
        for (const upload of uploads) {
            const remoteId = upload.remoteId ?? listed.find((row) => matchesPorntrexIdentity(row.title, upload.recordingId))?.remoteId ?? null;
            const row = remoteId ? listed.find((item) => item.remoteId === remoteId) : undefined;
            let porntrex = "not found in My Videos";
            let metadata: unknown = null;
            if (remoteId) {
                const edit = await get(sessionFile, `/edit-video/${remoteId}/`);
                const stored = edit.status === 200 ? parsePorntrexEditPage(edit.html) : null;
                if (stored) {
                    porntrex = "published";
                    metadata = upload.metadata ? comparePorntrexMetadata(upload.metadata, stored) : "no ledger metadata";
                } else {
                    porntrex = row?.processing ? "processing" : edit.status === 404 ? "edit page 404, not listed" : `edit page HTTP ${edit.status}`;
                }
            }
            rows.push({
                recording: upload.recordingId,
                remoteId,
                uploadedHoursAgo: hoursSince(upload.startedAt, now),
                porntrex,
                titleListed: row ? row.title === upload.metadata?.title : null,
                metadata,
                pipeline: upload.verifiedAt ? `verified ${upload.verifiedAt}` : upload.confirmAfter ? `next check ${upload.confirmAfter}` : upload.state,
            });
        }
        const lastCheck = database.listProviderSessionEvents("porntrex").filter((event) => event.kind === "keepalive").at(-1);
        const count = (predicate: (row: typeof rows[number]) => boolean) => rows.filter(predicate).length;
        return {
            session: { shared: session ? sessionFingerprint(session.cookies) : null, lastKeepalive: lastCheck ? `${lastCheck.occurredAt} ${lastCheck.loggedIn ? "logged in" : lastCheck.note}` : null },
            summary: {
                uploads: rows.length,
                processing: count((row) => row.porntrex === "processing"),
                published: count((row) => row.porntrex === "published"),
                metadataOk: count((row) => (row.metadata as { ok?: boolean } | null)?.ok === true),
                metadataProblems: count((row) => (row.metadata as { ok?: boolean } | null)?.ok === false),
                verified: count((row) => row.pipeline.startsWith("verified")),
                missing: count((row) => row.porntrex.startsWith("not found") || row.porntrex.includes("not listed")),
            },
            uploads: rows,
        };
    } finally {
        database.close();
    }
}
