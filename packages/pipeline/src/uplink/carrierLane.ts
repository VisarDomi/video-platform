import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { open as openFile, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { journalPriority } from "shared";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { ordered } from "../campaign/campaignWorker.js";
import { allowsUpload } from "../provenance/uploadPolicy.js";
import { RESOLUTION_POLICY_VERSION } from "../stages/resolutionPolicy.js";
import { carrierFileNameOk, carrierFor, type Carrier } from "./carrier.js";
import { CARRIER_FILES, CARRIER_MARKER } from "./protocol.js";
import type { Recording } from "../domain/types.js";

// Room left on the carrier after a copy, for the filesystem's own needs.
export const CARRIER_MARGIN_BYTES = 1_000_000_000;
export const CARRIER_PASS_MILLISECONDS = 30_000;

export type CarrierNotice = "ready" | "full" | "unknown";
export type Notify = (notice: CarrierNotice, title: string, body: string) => void;

export interface CarrierPassResult {
    readonly present: boolean;
    readonly marker?: "ok" | "missing" | "other";
    readonly deleted: Array<{ file: string; why: string }>;
    readonly lost: string[];
    readonly copied: string[];
    readonly refused: Array<{ file: string; why: string }>;
    readonly waiting: number;
    readonly full: boolean;
    readonly freeBytes: number | null;
    readonly gone?: string;
}

async function sha256(file: string, signal?: AbortSignal): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

async function syncPath(target: string): Promise<void> {
    const handle = await openFile(target, "r");
    try { await handle.sync(); } finally { await handle.close(); }
}

async function markerOf(root: string, id: string): Promise<"ok" | "missing" | "other"> {
    let text: string;
    try { text = await readFile(path.join(root, CARRIER_MARKER), "utf8"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
    }
    try { return (JSON.parse(text) as { carrier?: unknown }).carrier === id ? "ok" : "other"; } catch { return "other"; }
}

// The ready recordings the carrier should take, oldest first, after home keeps its reserve:
// walking the same order, the first ones whose sizes fit in what home may still send today
// plus one daily amount stay home.
export function carrierCandidates(database: PipelineDatabase, config: Pick<PipelineConfig, "uploadTimeZone">, now: Date):
    { reserveBytes: number; kept: number; candidates: Array<{ recording: Recording; path: string; name: string; sizeBytes: number; sha256: string }> } {
    const control = database.getCampaignControl();
    const home = database.uploadBudget(now, config.uploadTimeZone, control.dailyUploadLimitBytes);
    const reserveBytes = home.remainingBytes + control.dailyUploadLimitBytes;
    const ready = ordered(database.list("metadata_ready"), control.providerFilter).flatMap((recording) => {
        const artifact = database.getArtifact(recording.id);
        const name = artifact ? path.basename(artifact.path) : "";
        if (!artifact || !carrierFileNameOk(name) || database.carrierCopy(recording.id) || !database.canAttemptUpload(recording.id, now)
            || database.localSourceIsAbsent(recording.id) || !database.hasResolutionPolicyAssessment(recording.id, RESOLUTION_POLICY_VERSION)
            || !allowsUpload(database.getProvenance(recording.id))) return [];
        return [{ recording, path: artifact.path, name, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256 }];
    });
    let kept = 0, reserved = 0;
    while (kept < ready.length && reserved + ready[kept].sizeBytes <= reserveBytes) reserved += ready[kept++].sizeBytes;
    return { reserveBytes, kept, candidates: ready.slice(kept) };
}

// One pass while the carrier is in the PC: clean (delete what the site accepted or what is
// stale, and anything the ledger does not know), check (a recorded file that is missing or
// the wrong size is the PC's again), copy (file first, read back against the ledger's hash,
// renamed, then the row), close. Any error means the drive is gone: the pass stops there,
// and the ledger holds only what was finished before it.
export async function carrierPass(database: PipelineDatabase, config: Pick<PipelineConfig, "uploadTimeZone">, carrier: Carrier,
    options: { now?: () => Date; notify?: Notify; signal?: AbortSignal; maxCopies?: number } = {}): Promise<CarrierPassResult> {
    const now = options.now ?? (() => new Date());
    const result = { present: false, deleted: [] as CarrierPassResult["deleted"], lost: [] as string[], copied: [] as string[],
        refused: [] as CarrierPassResult["refused"], waiting: 0, full: false, freeBytes: null as number | null } as {
        -readonly [K in keyof CarrierPassResult]: CarrierPassResult[K] };
    if (!await carrier.present()) {
        if (database.carrierState(carrier.id)?.location === "home") database.saveCarrierState(carrier.id, { location: "away", freeBytes: null, note: "left the PC" }, now());
        return result;
    }
    result.present = true;
    let root: string | null = null;
    try {
        root = await carrier.open();
        result.marker = await markerOf(root, carrier.id);
        if (result.marker !== "ok") {
            database.saveCarrierState(carrier.id, { location: "home", freeBytes: null, note: `carrier.json ${result.marker === "missing" ? "is missing" : "names another carrier"}` }, now());
            if (database.noteCarrierNotice(carrier.id, "unknown", now())) {
                options.notify?.("unknown", `Drive ${carrier.id} is not a set-up carrier`,
                    `Its carrier.json ${result.marker === "missing" ? "is missing (run carrier-init)" : "names another carrier"}; nothing is copied to it.`);
            }
            return result;
        }
        const files = path.join(root, CARRIER_FILES);
        const rows = new Map(database.carrierFiles(carrier.id, "copied").map((row) => [row.fileName, row]));
        // Clean.
        for (const name of await readdir(files)) {
            const file = path.join(files, name);
            if (name.endsWith(".partial")) {
                await unlink(file);
                result.deleted.push({ file: name, why: "an unfinished copy" });
                continue;
            }
            if (name.startsWith(".")) continue;
            const row = rows.get(name);
            const verdict = row ? database.carrierFileVerdict(row) : "unknown";
            if (verdict === "keep") continue;
            await unlink(file);
            result.deleted.push({ file: name, why: verdict === "unknown" ? "not in the ledger" : verdict === "uploaded" ? "the site accepted it" : "stale" });
            if (row) { database.settleCarrierFile(carrier.id, name, verdict as "uploaded" | "removed", now()); rows.delete(name); }
        }
        if (result.deleted.length) await syncPath(files);
        // Check.
        for (const row of rows.values()) {
            const info = await stat(path.join(files, row.fileName)).catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return null;
                throw error;
            });
            if (info?.isFile() && info.size === row.sizeBytes) continue;
            if (info) await unlink(path.join(files, row.fileName));
            const verdict = database.carrierFileVerdict(row);
            database.settleCarrierFile(carrier.id, row.fileName, verdict === "uploaded" ? "uploaded" : "removed", now());
            result.lost.push(row.fileName);
        }
        // Copy.
        const { candidates } = carrierCandidates(database, config, now());
        result.waiting = candidates.length;
        for (const candidate of candidates) {
            if (options.signal?.aborted || result.copied.length >= (options.maxCopies ?? Infinity)) break;
            const freeBytes = await carrier.freeBytes(root);
            if (freeBytes - candidate.sizeBytes < CARRIER_MARGIN_BYTES) { result.full = true; break; }
            const partial = path.join(files, `${candidate.name}.partial`);
            const final = path.join(files, candidate.name);
            // Stops at once when the worker stops (the .partial file is deleted by the next pass).
            await pipeline(createReadStream(candidate.path, { signal: options.signal }), createWriteStream(partial, { signal: options.signal }));
            await syncPath(partial);
            if (await sha256(partial, options.signal) !== candidate.sha256) {
                await unlink(partial);
                result.refused.push({ file: candidate.name, why: "the copy read back differs from the ledger's hash" });
                continue;
            }
            await rename(partial, final);
            await syncPath(files);
            if (!database.recordCarrierCopy(carrier.id, candidate.name, candidate.recording.id, candidate.sha256, now())) {
                await unlink(final);
                await syncPath(files);
                result.refused.push({ file: candidate.name, why: "it left the ready queue while it was copied" });
                continue;
            }
            result.copied.push(candidate.name);
            result.waiting--;
        }
        result.freeBytes = await carrier.freeBytes(root);
        await carrier.close(root);
        root = null;
        database.saveCarrierState(carrier.id, { location: "home", freeBytes: result.freeBytes, note: null }, now());
        const state = database.carrierState(carrier.id)!;
        const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(0)} GB`;
        if (result.full && database.noteCarrierNotice(carrier.id, "full", now())) {
            options.notify?.("full", `Drive ${carrier.id} is full: take it to the office`,
                `${gigabytes(state.inTransitBytes)} on it for the office; ${result.waiting} more ready recording(s) wait for it.`);
        } else if (!result.full && result.waiting === 0 && !options.signal?.aborted && database.noteCarrierNotice(carrier.id, "ready", now())) {
            options.notify?.("ready", `Drive ${carrier.id} is ready`,
                `${gigabytes(state.inTransitBytes)} on it for the office; ${gigabytes(result.freeBytes ?? 0)} free. It may be pulled at any moment.`);
        }
        return result;
    } catch (error) {
        result.gone = error instanceof Error ? error.message : String(error);
        if (root) await carrier.close(root).catch(() => undefined);
        return result;
    }
}

// Whether a pass has work while the carrier stays plugged in: a recorded file to delete, or
// a recording to copy while the last pass did not find the drive full.
export function carrierHasWork(database: PipelineDatabase, config: Pick<PipelineConfig, "uploadTimeZone">, carrierId: string,
    lastWasFull: boolean, now = new Date()): boolean {
    if (database.carrierFiles(carrierId, "copied").some((file) => database.carrierFileVerdict(file) !== "keep")) return true;
    return !lastWasFull && carrierCandidates(database, config, now).candidates.length > 0;
}

// The carrier lane: every 30 seconds while the worker runs (and the setting names a
// carrier), a pass when the drive was just plugged in or the ledger says there is work (so
// an idle drive is not mounted again and again), each with its own ledger connection.
export async function runCarrierLane(config: PipelineConfig, signal: AbortSignal, notify: Notify,
    carrier: Carrier | null = config.uplink ? carrierFor(config.uplink) : null, intervalMs = CARRIER_PASS_MILLISECONDS): Promise<void> {
    if (!carrier) return;
    let last = "";
    let plugged = false, lastWasFull = false;
    while (!signal.aborted) {
        try {
            const database = new PipelineDatabase(config.databasePath);
            try {
                const present = await carrier.present();
                if (present && plugged && !carrierHasWork(database, config, carrier.id, lastWasFull)) {
                    await pause(intervalMs, signal);
                    continue;
                }
                const result = await carrierPass(database, config, carrier, { notify, signal });
                // A pass that ran to its end settles the plug-in; a pulled drive is looked at anew.
                plugged = result.present && !result.gone && result.marker === "ok";
                lastWasFull = result.full;
                const summary = JSON.stringify({ present: result.present, marker: result.marker, deleted: result.deleted, lost: result.lost,
                    copied: result.copied, refused: result.refused, full: result.full, gone: result.gone });
                if (summary !== last && (result.copied.length || result.deleted.length || result.lost.length || result.refused.length
                    || result.gone || last === "" || JSON.parse(last).present !== result.present)) {
                    console.log(JSON.stringify({ event: "carrier-pass", carrier: carrier.id, ...result }));
                }
                last = summary;
                // More to copy: go on at once.
                if (result.copied.length && result.waiting > 0 && !result.full && !result.gone) continue;
            } finally { database.close(); }
        } catch (error) {
            console.error(journalPriority("error", 2) + JSON.stringify({ event: "carrier-lane-error", error: error instanceof Error ? error.message : String(error) }));
        }
        await pause(intervalMs, signal);
    }
}

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, milliseconds);
        function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
        signal.addEventListener("abort", done, { once: true });
    });
}
