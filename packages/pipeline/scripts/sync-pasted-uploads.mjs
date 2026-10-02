#!/usr/bin/env node
// Explicit, offline adoption of user-supplied upload listings. Never uploads,
// changes provider metadata, re-encodes, or infers Full-HD verification.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { pipelineConfig } from '../dist/config.js';
import { inspectFinalizedRecording } from '../dist/discovery/inspectRecording.js';
import { readRecordingFinalization } from '../dist/discovery/recordingFinalization.js';
import { artifactSha256 } from '../dist/stages/validateArtifact.js';

export function parseListing(text, evidenceFile) {
    const blocks = text.split(/(?=^\s*\[.*\]\(https:\/\/www\.xvideos\.com\/video\.)/m)
        .filter(block => block.includes('https://www.xvideos.com/video.'));
    return blocks.map(block => {
        const heading = block.match(/^\s*\[(.*)\]\((https:\/\/www\.xvideos\.com\/video\.[^\s)]+)\)/);
        if (!heading) throw Error(`Malformed video heading in ${evidenceFile}`);
        const title = heading[1].replaceAll('\\]', ']');
        const suffix = title.match(/\[(\d{4}-\d{2}-\d{2} \d{6} [^\[\]]+)\]$/)?.[1];
        if (!suffix) throw Error(`Missing filename suffix in ${evidenceFile}`);
        const parts = suffix.split(' | ');
        if (parts.length > 1 && (parts.length !== 3 || !/^production-v\d+$/.test(parts[1]) || parts[2] !== 'full')) {
            throw Error(`Refusing partial/unknown artifact identity: ${suffix}`);
        }
        if (path.basename(parts[0]) !== parts[0] || parts[0].includes('\\')) throw Error('Unsafe filename suffix');
        const ids = [...new Set([...block.matchAll(/https:\/\/www\.xvideos\.com\/account\/uploads\/(\d+)\/edit/g)].map(m => m[1]))];
        if (ids.length > 1) throw Error(`Multiple edit IDs in one listing block: ${suffix}`);
        return { recordingId: parts[0], remoteId: ids[0] ?? null, remoteUrl: heading[2], title, evidenceFile };
    });
}

const videoKey = url => new URL(url).pathname.split('/')[1];

async function archiveEvidence(config) {
    const root = path.join(path.dirname(config.databasePath), 'history');
    const evidence = [];
    for (const version of await fs.readdir(root)) {
        if (!/^production-v\d+$/.test(version)) continue;
        for (const file of await fs.readdir(path.join(root, version))) {
            if (!file.endsWith('.sqlite')) continue;
            const snapshot = path.join(root, version, file);
            const db = new DatabaseSync(snapshot, { readOnly: true });
            try {
                for (const row of db.prepare(`SELECT r.*, a.path AS artifact_path, a.size_bytes,
                    a.sha256, a.validated_at, u.remote_id, u.remote_url,
                    v.verified_at AS remote_verified_at FROM recordings r
                    JOIN artifacts a ON a.recording_id=r.id AND a.part='full'
                    JOIN upload_attempts u ON u.recording_id=r.id AND u.artifact_part='full'
                    LEFT JOIN remote_uploads v ON v.recording_id=r.id AND v.remote_id=u.remote_id
                    WHERE u.remote_id IS NOT NULL AND u.status IN ('accepted','uncertain')`).all()) {
                    evidence.push({ ...row, version, snapshot,
                        metadata: db.prepare('SELECT * FROM upload_metadata WHERE recording_id=?').get(row.id) });
                }
            } finally { db.close(); }
        }
    }
    return evidence;
}

export async function planSync(files, config = pipelineConfig) {
    const entries = (await Promise.all(files.map(async file => parseListing(await fs.readFile(file, 'utf8'), path.resolve(file))))).flat();
    if (!entries.length) throw Error('No upload entries found');
    const grouped = Map.groupBy(entries, entry => entry.recordingId);
    const archives = await archiveEvidence(config);
    const db = new DatabaseSync(config.databasePath, { readOnly: true });
    try {
        const generation = db.prepare('SELECT version FROM production_version WHERE id=1').get().version;
        if (path.basename(config.stagingRoot) !== generation) throw Error('Staging/generation mismatch');
        const alreadyLinked = [], imports = [], conflicts = [], replacements = [];
        for (const [recordingId, options] of grouped) {
            const current = db.prepare('SELECT * FROM recordings WHERE id=?').get(recordingId);
            const currentRemotes = db.prepare(`SELECT remote_id,remote_url FROM upload_attempts WHERE recording_id=?
                AND remote_id IS NOT NULL AND status IN ('accepted','uncertain')`).all(recordingId);
            if (current) {
                const match = options.find(entry => currentRemotes.some(remote => entry.remoteId
                    ? remote.remote_id === entry.remoteId
                    : remote.remote_url && videoKey(remote.remote_url) === videoKey(entry.remoteUrl)));
                if (match) alreadyLinked.push({ recordingId, remoteId: match.remoteId ?? currentRemotes.find(r => r.remote_url && videoKey(r.remote_url) === videoKey(match.remoteUrl)).remote_id });
                else conflicts.push({ recordingId, reason: 'Existing v6 record needs explicit reconciliation; left untouched' });
                continue;
            }
            const sourceMatches = [];
            for (const root of config.discoveryRoots) {
                const sourcePath = path.join(root.path, recordingId);
                if ((await fs.lstat(sourcePath).catch(() => null))?.isDirectory()) sourceMatches.push({ root, sourcePath });
            }
            if (sourceMatches.length !== 1) throw Error(`Expected one exact source folder for ${recordingId}`);
            const { root, sourcePath } = sourceMatches[0];
            const inspection = await inspectFinalizedRecording(sourcePath, root.provider, 'edited');
            if (inspection.status !== 'finalized') throw Error(`Source is not finalized: ${recordingId}`);
            const source = inspection.recording;
            if (!readRecordingFinalization(config.finalizationDatabasePath, sourcePath, await fs.readFile(source.playlistPath, 'utf8'))) {
                throw Error(`No exact ready checkpoint: ${recordingId}`);
            }
            const candidates = archives.filter(a => a.id === recordingId && a.provider === root.provider
                && a.source_path === sourcePath && a.source_fingerprint === source.sourceFingerprint
                && options.some(o => o.remoteId === a.remote_id));
            const provenReplacements = candidates.filter(a => a.remote_verified_at && Number(a.version.slice(12)) >= 4)
                .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
            const distinctIds = [...new Set(options.map(o => o.remoteId).filter(Boolean))];
            const candidate = provenReplacements[0] ?? (distinctIds.length === 1 ? candidates[0] : null);
            if (!candidate) { conflicts.push({ recordingId, reason: 'No matching validated archive evidence for a single supplied upload' }); continue; }
            const entry = options.find(o => o.remoteId === candidate.remote_id);
            if (distinctIds.length > 1) replacements.push({ recordingId, chosen: entry.remoteId, alternatives: distinctIds.filter(id => id !== entry.remoteId), reason: 'Replacement verified in v4 or later' });
            if (db.prepare('SELECT 1 FROM upload_attempts WHERE remote_id=? AND recording_id<>?').get(entry.remoteId, recordingId)) throw Error('Remote ID already belongs to another recording');
            const expectedRoot = path.join(config.artifactsRoot, candidate.version);
            if (path.dirname(candidate.artifact_path) !== expectedRoot || await fs.realpath(candidate.artifact_path) !== candidate.artifact_path) throw Error('Unsafe archived artifact path');
            if ((await fs.stat(candidate.artifact_path)).size !== candidate.size_bytes) throw Error(`Archived artifact size changed: ${recordingId}`);
            imports.push({ ...entry, source, archive: candidate,
                // Keep imported historical bytes distinct from outputs of the
                // current recipe, including after an interrupted import.
                artifactPath: path.join(config.stagingRoot, `${recordingId}.existing-${entry.remoteId}.mp4`) });
        }
        return { generation, listingEntries: entries.length, distinctRecordings: grouped.size, alreadyLinked, replacements, conflicts, imports };
    } finally { db.close(); }
}

export async function applySync(plan, config = pipelineConfig) {
    if (plan.conflicts.length) throw Error('Resolve reported conflicts before applying');
    // All files are checked before changing any ledger row. Hardlinks preserve
    // the historical copy and do not consume another full file's disk space.
    await fs.mkdir(config.stagingRoot, { recursive: true });
    for (const item of plan.imports) {
        try { await fs.link(item.archive.artifact_path, item.artifactPath); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!(await fs.lstat(item.artifactPath)).isFile() || await artifactSha256(item.artifactPath) !== item.archive.sha256) throw Error(`Artifact checksum mismatch: ${item.recordingId}`);
    }
    const db = new DatabaseSync(config.databasePath);
    try {
        db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        const reportRoot = path.join(path.dirname(config.databasePath), 'sync-history');
        await fs.mkdir(reportRoot, { recursive: true, mode: 0o700 });
        const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`;
        const snapshot = path.join(reportRoot, `${runId}.sqlite`);
        db.prepare('VACUUM INTO ?').run(snapshot);
        await fs.chmod(snapshot, 0o600);
        db.exec('BEGIN IMMEDIATE');
        try {
            if (db.prepare('SELECT version FROM production_version WHERE id=1').get().version !== plan.generation) throw Error('Generation changed during import');
            const timestamp = new Date().toISOString();
            for (const item of plan.imports) {
                if (db.prepare('SELECT 1 FROM recordings WHERE id=? OR source_path=?').get(item.recordingId, item.source.sourcePath)) throw Error(`Recording admitted during planning: ${item.recordingId}`);
                if (db.prepare('SELECT 1 FROM upload_attempts WHERE remote_id=?').get(item.remoteId)) throw Error('Remote identity changed during planning');
                const attemptId = randomUUID();
                // This is a historical import, not a fabricated conversion or
                // network submission. Publish its terminal local-work state
                // atomically so the live worker can never pick it for upload.
                db.prepare(`INSERT INTO recordings (id,provider,source_kind,source_path,playlist_path,source_fingerprint,
                    duration_seconds,state,created_at,updated_at) VALUES (?,?,'edited',?,?,?,?,'xvideos_uncertain',?,?)`)
                    .run(item.recordingId, item.source.provider, item.source.sourcePath, item.source.playlistPath,
                        item.source.sourceFingerprint, item.source.durationSeconds, timestamp, timestamp);
                db.prepare(`INSERT INTO artifacts (recording_id,part,path,size_bytes,sha256,validated_at) VALUES (?,'full',?,?,?,?)`)
                    .run(item.recordingId, item.artifactPath, item.archive.size_bytes, item.archive.sha256, item.archive.validated_at);
                if (item.archive.metadata) db.prepare(`INSERT INTO upload_metadata (recording_id,title,description,tags_json,created_at) VALUES (?,?,?,?,?)`)
                    .run(item.recordingId, item.title, item.archive.metadata.description, item.archive.metadata.tags_json, timestamp);
                const evidence = { stage: 'user_supplied_listing_import', remoteId: item.remoteId, title: item.title,
                    evidenceFile: item.evidenceFile, archiveSnapshot: item.archive.snapshot,
                    artifactSha256: item.archive.sha256, checkedAt: timestamp,
                    reason: 'Existing upload imported; no conversion or transfer; current playback quality unverified' };
                db.prepare(`INSERT INTO upload_attempts (id,recording_id,provider,status,phase,remote_id,remote_url,
                    error,started_at,completed_at,evidence_json) VALUES (?,?,?,'uncertain','metadata_submitting',?,?,?,?,?,?)`)
                    .run(attemptId, item.recordingId, 'xvideos', item.remoteId, item.remoteUrl,
                        'Imported existing upload from user listing; awaiting playback verification', timestamp, timestamp, JSON.stringify([evidence]));
                db.prepare(`INSERT INTO upload_confirmations (attempt_id,recording_id,confirm_after,status) VALUES (?,?,?,'pending')`)
                    .run(attemptId, item.recordingId, timestamp);
                db.prepare(`INSERT INTO state_events (recording_id,from_state,to_state,reason,created_at) VALUES (?,NULL,'xvideos_uncertain',?,?)`)
                    .run(item.recordingId, `User-authorized existing upload import ${item.remoteId}; historical artifact retained for verification, not a new-policy encode`, timestamp);
            }
            db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        return { snapshot, imported: plan.imports.length, alreadyLinked: plan.alreadyLinked.length,
            replacements: plan.replacements, uploadBytes: 0, playbackVerifiedByImport: false };
    } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    const args = process.argv.slice(2), apply = args.includes('--apply');
    const files = args.filter(arg => arg !== '--apply');
    if (!files.length || files.some(file => file.startsWith('--'))) throw Error('Usage: sync-pasted-uploads.mjs [--apply] FILE...');
    const plan = await planSync(files);
    console.log(JSON.stringify(apply ? await applySync(plan) : {
        generation: plan.generation, listingEntries: plan.listingEntries, distinctRecordings: plan.distinctRecordings,
        alreadyLinked: plan.alreadyLinked.length, replacements: plan.replacements, conflicts: plan.conflicts,
        imports: plan.imports.map(i => ({ recordingId: i.recordingId, remoteId: i.remoteId, archive: i.archive.version })),
    }, null, 2));
}
