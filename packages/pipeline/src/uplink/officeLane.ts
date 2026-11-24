import { HumanActionRequiredError, MetadataRejectedError, ProviderSessionLostError, TransferAbortedBeforeSubmissionError } from "sdk";
import { journalPriority } from "shared";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { ordered } from "../campaign/campaignWorker.js";
import type { AccountSlot } from "../campaign/accountSlot.js";
import { REQUEST_OVERHEAD_RESERVATION_BYTES } from "../domain/uploadBudget.js";
import { uploadOne } from "../commands/uploadOne.js";
import { carrierId } from "../upload/providerFactory.js";
import { probeUplink, releaseUplinkCarrier, type UplinkProbe } from "./uplinkCommands.js";
import type { Recording } from "../domain/types.js";

export const OFFICE_IDLE_MILLISECONDS = 5 * 60_000;
export const OFFICE_BUSY_MILLISECONDS = 30_000;

export type OfficeNotify = (notice: "done" | "person", title: string, body: string) => void;

export interface OfficeTick {
    readonly action: "off" | "nothing_on_carrier" | "awaiting_first_upload" | "carrier_home" | "held" | "away" | "waiting_allowance" | "busy" | "uploaded" | "failed" | "done";
    readonly recordingId?: string;
    readonly detail?: string;
    readonly result?: unknown;
}

// Why the whole campaign says no upload may go anywhere: a manual pause, an attention hold
// (a lost session: the office shares it), a trial or comparison run (they keep their order).
function campaignForbids(database: PipelineDatabase): string | null {
    const control = database.getCampaignControl();
    if (control.state === "paused" && control.resumeAt === null) return control.attentionReason ?? "the campaign is paused";
    if (control.trialPerProvider !== null || database.getComparisonTrial()) return "a trial or comparison run keeps its own order";
    return null;
}

// The ready recordings whose carrier copy the runner sees on the drive (name and size),
// oldest first.
function sendable(database: PipelineDatabase, probe: UplinkProbe, id: string, now: Date): Recording[] {
    const listed = new Map(probe.carrier.files.map((file) => [file.name, file.sizeBytes]));
    const control = database.getCampaignControl();
    return ordered(database.list("metadata_ready").filter((recording) => {
        const copy = database.carrierCopy(recording.id);
        return copy?.carrierId === id && listed.get(copy.fileName) === copy.sizeBytes
            && database.carrierFileVerdict({ recordingId: recording.id, sha256: copy.sha256 }) === "keep"
            && database.canAttemptUpload(recording.id, now);
    }), control.providerFilter);
}

// One look at the office: is the drive there on the office network, and is there a file to
// send within the office's allowance? Then one upload, through the same uploadOne as home,
// holding the account slot. A failure holds this lane only (its own backoff in the ledger);
// the home campaign and its cooldowns are untouched, and nothing here ever signs in.
export async function officeTick(config: PipelineConfig, slot: AccountSlot | null, notify: OfficeNotify,
    options: { now?: () => Date; upload?: (recordingId: string) => Promise<unknown>; extraHold?: () => string | null; signal?: AbortSignal } = {}): Promise<OfficeTick> {
    const uplink = config.uplink;
    if (!uplink || !config.networkUploadsEnabled) return { action: "off" };
    const now = options.now ?? (() => new Date());
    const id = carrierId(uplink);
    const database = new PipelineDatabase(config.databasePath);
    try {
        if (!database.carrierFiles(id, "copied").length) return { action: "nothing_on_carrier" };
        // The first upload from a new uplink is a person's (supervised, with upload-one): the
        // lane sends nothing until one settled with the site's video ID.
        if (!database.uplinkHasSentOne(uplink.id)) return { action: "awaiting_first_upload" };
        if (database.carrierState(id)?.location === "home") return { action: "carrier_home" };
        const hold = database.uplinkHold(uplink.id);
        if (hold?.resumeAt && Date.parse(hold.resumeAt) > now().getTime()) return { action: "held", detail: `${hold.reason} (until ${hold.resumeAt})` };
        const forbidden = campaignForbids(database) ?? options.extraHold?.() ?? null;
        if (forbidden) return { action: "held", detail: forbidden };
        let probe: UplinkProbe;
        try { probe = await probeUplink(config, undefined, options.signal); } catch (error) {
            return { action: "away", detail: `the runner did not answer: ${error instanceof Error ? error.message : String(error)}` };
        }
        if (!probe.carrier.matches) {
            if (database.carrierState(id)?.location === "uplink") database.saveCarrierState(id, { location: "away", freeBytes: null, note: "not at the office" }, now());
            return { action: "away", detail: "the carrier is not at the uplink's machine" };
        }
        if (!probe.onUplink) {
            database.saveCarrierState(id, { location: "away", freeBytes: probe.carrier.freeBytes, note: `seen by the runner on network ${probe.identity}` }, now());
            return { action: "away", detail: `the runner is on network ${probe.identity}, not the uplink's` };
        }
        database.saveCarrierState(id, { location: "uplink", freeBytes: probe.carrier.freeBytes, note: null }, now());
        const next = sendable(database, probe, id, now())[0];
        if (!next) {
            // Nothing left to send: the drive may go home.
            if (database.noteCarrierNotice(id, "done", now())) {
                const released = await releaseUplinkCarrier(config, options.signal).catch((error: Error) => ({ unmounted: false, note: error.message }));
                notify("done", `Drive ${id} is done at the office`,
                    `Everything on it was sent${released.unmounted ? "; it was unmounted and may be pulled" : ""}. Bring it home to clean and refill it.`);
            }
            return { action: "done" };
        }
        const artifact = database.getArtifact(next.id)!;
        if (!database.canReserve(artifact.sizeBytes + REQUEST_OVERHEAD_RESERVATION_BYTES, now(), config.uploadTimeZone, uplink.dailyBytes, uplink.id)) {
            return { action: "waiting_allowance", recordingId: next.id };
        }
        const release = slot ? slot.tryTake("office-upload") : () => undefined;
        if (!release) return { action: "busy", detail: `the account slot is held by ${slot?.heldBy}` };
        try {
            const result = await (options.upload ?? ((recordingId) => uploadOne(recordingId, config, { uplink: uplink.id })))(next.id);
            database.clearUplinkHold(uplink.id, now());
            return { action: "uploaded", recordingId: next.id, result };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A carrier copy the runner refused (missing, the wrong size or hash) is home's
            // again: copied anew when the drive is back.
            if (error instanceof TransferAbortedBeforeSubmissionError && /carrier file .* (is missing|does not match)/.test(message)) {
                const copy = database.carrierCopy(next.id);
                if (copy) database.settleCarrierFile(copy.carrierId, copy.fileName, "removed", now());
                return { action: "failed", recordingId: next.id, detail: message };
            }
            // Refused words: nothing was created and the recording is described again; not
            // the office's failure.
            if (error instanceof MetadataRejectedError) return { action: "failed", recordingId: next.id, detail: message };
            const person = error instanceof HumanActionRequiredError || error instanceof ProviderSessionLostError;
            const held = database.recordUplinkFailure(uplink.id, message.slice(0, 500), person, now());
            if (person) notify("person", `Office uploads need you`, `${message.slice(0, 300)} (held until ${held.resumeAt})`);
            return { action: "failed", recordingId: next.id, detail: `${message} (held until ${held.resumeAt})` };
        } finally { release(); }
    } finally { database.close(); }
}

// The office lane: an office tick every five minutes (30 seconds while the slot is busy, at
// once after an upload), beside the worker's main loop.
export async function runOfficeLane(config: PipelineConfig, signal: AbortSignal, slot: AccountSlot, notify: OfficeNotify,
    extraHold: () => string | null = () => null): Promise<void> {
    if (!config.uplink) return;
    let last = "";
    while (!signal.aborted) {
        let wait = OFFICE_IDLE_MILLISECONDS;
        try {
            const tick = await officeTick(config, slot, notify, { extraHold, signal });
            const summary = JSON.stringify({ action: tick.action, recordingId: tick.recordingId, detail: tick.detail });
            if (summary !== last || tick.action === "uploaded") console.log(JSON.stringify({ event: "office-lane", ...tick }));
            last = summary;
            if (tick.action === "uploaded") wait = 0;
            else if (tick.action === "busy") wait = OFFICE_BUSY_MILLISECONDS;
        } catch (error) {
            console.error(journalPriority("error", 2) + JSON.stringify({ event: "office-lane-error", error: error instanceof Error ? error.message : String(error) }));
        }
        if (wait) await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            const timer = setTimeout(done, wait);
            function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
            signal.addEventListener("abort", done, { once: true });
        });
    }
}
