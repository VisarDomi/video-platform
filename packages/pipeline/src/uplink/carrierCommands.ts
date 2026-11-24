import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { writeFileDurably } from "sdk";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { carrierFor, type Carrier } from "./carrier.js";
import { carrierCandidates } from "./carrierLane.js";
import { CARRIER_FILES, CARRIER_MARKER } from "./protocol.js";
import { requireUplink } from "./uplinkCommands.js";

// Sets a drive up as the carrier: its marker (carrier.json, naming it), the files folder,
// and the file that keeps the Mac's Spotlight from indexing it. An empty drive only, or one
// already set up as this carrier (then nothing changes).
export async function initCarrier(config: Pick<PipelineConfig, "uplink">, carrier: Carrier = carrierFor(requireUplink(config))): Promise<unknown> {
    if (!await carrier.present()) throw new Error(`Carrier ${carrier.id} is not in the PC`);
    const root = await carrier.open();
    try {
        const marker = path.join(root, CARRIER_MARKER);
        const existing = await stat(marker).then(() => true, () => false);
        if (existing) {
            const named = (JSON.parse(await readFile(marker, "utf8")) as { carrier?: unknown }).carrier;
            if (named !== carrier.id) throw new Error(`Carrier ${carrier.id}: carrier.json names ${String(named)}; refusing`);
        } else {
            const entries = (await readdir(root)).filter((name) => ![".Spotlight-V100", ".fseventsd", ".Trashes", ".metadata_never_index", "System Volume Information"].includes(name));
            if (entries.length) throw new Error(`Carrier ${carrier.id} is not empty (${entries.slice(0, 5).join(", ")}); refusing to set it up`);
        }
        await mkdir(path.join(root, CARRIER_FILES), { recursive: true });
        await writeFileDurably(path.join(root, ".metadata_never_index"), "");
        if (!existing) await writeFileDurably(marker, `${JSON.stringify({ carrier: carrier.id, version: 1 })}\n`);
        return { carrier: carrier.id, root, initialized: !existing };
    } finally { await carrier.close(root); }
}

export function carrierStatus(config: Pick<PipelineConfig, "uplink" | "databasePath" | "uploadTimeZone">, now = new Date()): unknown {
    const uplink = requireUplink(config);
    const carrier = carrierFor(uplink);
    const database = new PipelineDatabase(config.databasePath);
    try {
        const copied = database.carrierFiles(carrier.id, "copied");
        const { reserveBytes, kept, candidates } = carrierCandidates(database, config, now);
        return {
            carrier: carrier.id, state: database.carrierState(carrier.id), capacityBytes: uplink.carrier.capacityBytes,
            onCarrier: { files: copied.length, bytes: copied.reduce((sum, row) => sum + row.sizeBytes, 0) },
            homeReserve: { bytes: reserveBytes, recordings: kept },
            waitingForCarrier: { recordings: candidates.length, bytes: candidates.reduce((sum, row) => sum + row.sizeBytes, 0) },
        };
    } finally { database.close(); }
}

// Gives the carrier's files back to home (the drive in the PC): deletes them and settles
// their rows, except a file whose recording has an upload in flight.
export async function recallCarrier(config: Pick<PipelineConfig, "uplink" | "databasePath">, apply: boolean,
    carrier: Carrier = carrierFor(requireUplink(config)), now = new Date()): Promise<unknown> {
    if (!await carrier.present()) throw new Error(`Carrier ${carrier.id} is not in the PC; a recall needs the drive`);
    const database = new PipelineDatabase(config.databasePath);
    const root = await carrier.open();
    try {
        const files = database.carrierFiles(carrier.id, "copied");
        const busy = new Set(files.filter((file) => database.hasActiveUploadAttempt(file.recordingId)).map((file) => file.fileName));
        const recalled: string[] = [];
        if (apply) {
            for (const file of files) {
                if (busy.has(file.fileName)) continue;
                await unlink(path.join(root, CARRIER_FILES, file.fileName)).catch((error: NodeJS.ErrnoException) => {
                    if (error.code !== "ENOENT") throw error;
                });
                database.settleCarrierFile(carrier.id, file.fileName, "removed", now);
                recalled.push(file.fileName);
            }
            database.saveCarrierState(carrier.id, { location: "home", freeBytes: await carrier.freeBytes(root), note: "recalled" }, now);
        }
        return { carrier: carrier.id, apply, recalled: apply ? recalled : files.filter((file) => !busy.has(file.fileName)).map((file) => file.fileName),
            refused: [...busy].map((file) => ({ file, why: "an upload is in flight" })) };
    } finally {
        await carrier.close(root).catch(() => undefined);
        database.close();
    }
}

// A carrier that never comes back: its rows are settled and the recordings are home's again
// (the PC kept every file).
export function writeOffCarrier(config: Pick<PipelineConfig, "databasePath">, carrierId: string, now = new Date()): unknown {
    const database = new PipelineDatabase(config.databasePath);
    try {
        if (database.carrierFiles(carrierId, "copied").some((file) => database.hasActiveUploadAttempt(file.recordingId))) {
            throw new Error(`Carrier ${carrierId} has a file whose upload is in flight; write it off after it settled`);
        }
        return { carrier: carrierId, settled: database.writeOffCarrier(carrierId, now) };
    } finally { database.close(); }
}
