import path from "node:path";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { PipelineConfig } from "../config.js";
import { PipelineDatabase } from "../db/pipelineDatabase.js";
import { CURRENT_PRODUCTION_VERSION } from "../domain/productionVersion.js";
import { inspectFinalizedRecording } from "../discovery/inspectRecording.js";
import { readRecordingFinalization } from "../discovery/recordingFinalization.js";
import type { RecordingInput } from "../domain/types.js";

export async function selectComparisonFile(config: PipelineConfig, filePath: string): Promise<unknown> {
    await syncComparisonSelection(config, filePath);
    return writeComparisonReport(config);
}

async function inspectSelection(config: PipelineConfig, input: string): Promise<RecordingInput> {
    if (!path.isAbsolute(input)) throw new Error(`Use a full, unquoted recording-folder path: ${input}`);
    const sourcePath = path.resolve(input);
    const root = config.discoveryRoots.find((candidate) => candidate.sourceKind === "edited"
        && path.resolve(candidate.path) === path.dirname(sourcePath));
    if (!root) throw new Error(`Selection is not a managed edited recording: ${input}`);
    const inspection = await inspectFinalizedRecording(sourcePath, root.provider, "edited");
    if (inspection.status !== "finalized") throw new Error(`Invalid selection ${input}: ${inspection.reason}`);
    const playlist = await readFile(inspection.recording.playlistPath, "utf8");
    if (!readRecordingFinalization(config.finalizationDatabasePath, sourcePath, playlist)) {
        throw new Error(`Selection lacks an exact ready checkpoint: ${input}`);
    }
    return inspection.recording;
}

export async function syncComparisonSelection(config: PipelineConfig, filePath = config.comparisonSelectionFile): Promise<{ added: number; removed: number; errors: string[] }> {
    if (!filePath) return { added: 0, removed: 0, errors: [] };
    const database = new PipelineDatabase(config.databasePath);
    try {
        const trial = database.getComparisonTrial();
        if (!trial || database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION) return { added: 0, removed: 0, errors: [] };
        let content: string;
        try { content = await readFile(filePath, "utf8"); } catch (error) {
            const errors = [`Cannot read selection file ${filePath}: ${error instanceof Error ? error.message : String(error)}`];
            database.setComparisonFileErrors(errors);
            return { added: 0, removed: 0, errors };
        }
        const known = new Map(trial.selection.map((source) => [source.sourcePath, source]));
        const desired = new Map<string, RecordingInput>();
        const errors: string[] = [];
        for (const [index, line] of content.split(/\r?\n/).entries()) {
            const input = line.trim();
            if (!input || input.startsWith("#") || desired.has(path.resolve(input))) continue;
            try {
                const source = known.get(path.resolve(input)) ?? await inspectSelection(config, input);
                desired.set(source.sourcePath, source);
            } catch (error) {
                errors.push(`Line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        // Do not apply an obsolete snapshot if the operator saved again while
        // new paths were being checked. A missing file also never means empty.
        if (await readFile(filePath, "utf8").catch(() => null) !== content) {
            return { added: 0, removed: 0, errors: ["Selection changed during inspection; retrying on the next check"] };
        }
        const changes = database.syncComparisonQueue([...desired.values()]);
        database.setComparisonFileErrors(errors);
        return { ...changes, errors };
    } finally { database.close(); }
}

export async function selectComparisonRecordings(config: PipelineConfig, paths: readonly string[]): Promise<unknown> {
    const database = new PipelineDatabase(config.databasePath);
    try {
        if (database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION) throw new Error("Run campaign-prepare first");
        const selection: RecordingInput[] = [];
        for (const input of paths) {
            selection.push(await inspectSelection(config, input));
        }
        database.appendComparisonSelection(selection);
    } finally { database.close(); }
    return writeComparisonReport(config);
}

export async function writeComparisonReport(config: PipelineConfig): Promise<unknown> {
    const database = new PipelineDatabase(config.databasePath);
    try {
        const trial = database.getComparisonTrial();
        if (!trial || database.getProductionVersion() !== CURRENT_PRODUCTION_VERSION) return null;
        const rows = await Promise.all(trial.selection.map(async (source) => {
            const recording = database.getBySourcePath(source.sourcePath);
            const artifact = recording ? database.getArtifact(recording.id) : null;
            const artifactPath = artifact?.path ?? (recording ? database.getRemuxOutput(recording.id) : null);
            const exists = artifactPath ? await access(artifactPath).then(() => true, () => false) : false;
            const remote = recording ? database.getUploadIdentity(recording.id) : null;
            return {
                recordingId: path.basename(source.sourcePath), provider: source.provider,
                state: recording?.state ?? "selected", failure: recording?.blockReason ?? null,
                sourcePath: source.sourcePath, playlistPath: source.playlistPath,
                sourceFingerprint: source.sourceFingerprint, sourceDurationSeconds: source.durationSeconds,
                originalUrl: `${config.serverUrl}/videos/${source.provider}/${encodeURIComponent(path.basename(source.sourcePath))}?type=edited`,
                artifactPath, artifactExists: exists, artifactSha256: artifact?.sha256 ?? null,
                artifactSizeBytes: artifact?.sizeBytes ?? null,
                resolutionPolicy: recording ? database.comparisonPolicyReason(recording.id) : null,
                uploadId: remote?.remoteId ?? null, uploadedUrl: remote?.remoteUrl ?? null,
                uploadEditUrl: remote ? `https://www.xvideos.com/account/uploads/${remote.remoteId}/edit` : null,
                verifiedOnline: remote?.verified ?? false,
                // Online verification is not an assertion of frame fidelity.
                qualityApproved: false,
            };
        }));
        const report = { productionVersion: database.getProductionVersion(), updatedAt: new Date().toISOString(),
            state: database.getCampaignControl().state, selectedCount: rows.length,
            selectionFile: config.comparisonSelectionFile ?? null, fileErrors: trial.fileErrors,
            selectionLockedAt: trial.lockedAt, completedAt: trial.completedAt,
            automaticCleanup: false, recordings: rows };
        await mkdir(config.stagingRoot, { recursive: true });
        const escape = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("[", "\\[").replaceAll("]", "\\]");
        const markdown = ["# Selected v3 comparison trial", "", "Only the explicitly selected recordings below may run. Artifacts are retained until you explicitly request deletion. Online verification does not establish visual/frame fidelity.", "",
            `Queued so far: ${rows.length}. Campaign: ${report.state}. Queue drained: ${trial.completedAt ?? "not yet"}.`, "",
            ...trial.fileErrors.map((error) => `Selection-file error: ${escape(error)}`), "",
            "| Recording | State | Original | Converted/remuxed | Uploaded |", "| --- | --- | --- | --- | --- |",
            ...rows.map((row) => `| ${escape(row.recordingId)} | ${escape(row.failure ?? row.state)} | [original](${row.originalUrl}) | ${row.artifactPath ? `[${row.artifactExists ? "local MP4" : "MISSING"}](<${row.artifactPath}>)` : "pending"} | ${row.uploadedUrl ? `[${row.verifiedOnline ? "verified online" : "submitted"}](${row.uploadedUrl})` : row.uploadEditUrl ? `[awaiting verification](${row.uploadEditUrl})` : "pending"} |`), "",
            "The adjacent JSON report records source fingerprints, artifact SHA-256, policy decisions, and remote IDs.", ""].join("\n");
        for (const [name, content] of [["comparison.json", JSON.stringify(report, null, 2) + "\n"], ["comparison.md", markdown]]) {
            const target = path.join(config.stagingRoot, name);
            const temporary = `${target}.${randomUUID()}.tmp`;
            await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
            await rename(temporary, target);
        }
        return report;
    } finally { database.close(); }
}
