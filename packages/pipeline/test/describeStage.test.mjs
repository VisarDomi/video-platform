import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

// The describe stage's waits: a description model that does not start is the machine's
// trouble at that moment, never the recording's, and describing waits for a disk trim.
const root = await mkdtemp(path.join(os.tmpdir(), 'describe-stage-'));
process.env.VIDEO_PIPELINE_DESCRIBE_MIN_MEMORY_GIB = '0';
// Never the machine's model runtime, port or evidence: a runtime that does not exist.
const { descriptorConfig } = await import('descriptor');
Object.assign(descriptorConfig, { runtimeExecutable: path.join(root, 'no-such-runtime'), mediaDirectory: path.join(root, 'media'),
    evidenceDirectory: path.join(root, 'descriptions'), modelUrl: 'http://127.0.0.1:1', port: 1 });
const { describeValidatedArtifact, diskTrimRunning } = await import('../dist/stages/describe.js');
const { StageDeferredError } = await import('../dist/scheduler/orchestrator.js');
test.after(() => rm(root, { recursive: true, force: true }));

test('a description model that cannot start leaves the recording to a later step and logs why', async (t) => {
    const video = path.join(root, 'artifact.mp4');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-pix_fmt', 'yuv420p', video]);
    const lines = [];
    t.mock.method(console, 'log', line => lines.push(line));
    await assert.rejects(describeValidatedArtifact({ recordingId: 'recording-1', path: video, sha256: 'b'.repeat(64), sizeBytes: 1 }),
        error => error instanceof StageDeferredError && /description model did not start/.test(error.message));
    const event = lines.map(line => JSON.parse(line)).find(entry => entry.event === 'descriptor-start-failed');
    assert.equal(event.recordingId, 'recording-1');
    assert.match(event.error, /Failed to launch llama-server/);
    // A model that keeps failing to start is no passing state: the third time, the recording fails.
    const artifact = { recordingId: 'recording-1', path: video, sha256: 'b'.repeat(64), sizeBytes: 1 };
    await assert.rejects(describeValidatedArtifact(artifact), StageDeferredError);
    await assert.rejects(describeValidatedArtifact(artifact), error => !(error instanceof StageDeferredError) && /Failed to launch llama-server/.test(error.message));
    await assert.rejects(describeValidatedArtifact(artifact), StageDeferredError, 'the count starts again');
});

test('a running uncapped fstrim is found among the processes, while a slice-capped fstrim is not blocking', async () => {
    const proc = await mkdtemp(path.join(root, 'proc-'));
    const cgroup = await mkdtemp(path.join(root, 'cgroup-'));
    for (const [pid, name] of [['1', 'systemd'], ['812', 'node'], ['self', 'fstrim']]) {
        await mkdir(path.join(proc, pid));
        await writeFile(path.join(proc, pid, 'comm'), `${name}\n`);
    }
    assert.equal(await diskTrimRunning(proc, cgroup), false, 'only numbered process entries count');
    await mkdir(path.join(proc, '9001'));
    await writeFile(path.join(proc, '9001', 'comm'), 'fstrim\n');
    assert.equal(await diskTrimRunning(proc, cgroup), true);
    // An fstrim inside a slice with a finite write/discard IOPS cap does not block describing.
    await writeFile(path.join(proc, '9001', 'cgroup'), '0::/fstrim.slice/fstrim.service\n');
    await mkdir(path.join(cgroup, 'fstrim.slice', 'fstrim.service'), { recursive: true });
    await writeFile(path.join(cgroup, 'fstrim.slice', 'io.max'), '259:0 rbps=max wbps=max riops=max wiops=40\n');
    assert.equal(await diskTrimRunning(proc, cgroup), false);
    // Without a finite wiops cap (max), it still blocks.
    await writeFile(path.join(cgroup, 'fstrim.slice', 'io.max'), '259:0 rbps=max wbps=max riops=max wiops=max\n');
    assert.equal(await diskTrimRunning(proc, cgroup), true);
    assert.equal(await diskTrimRunning(path.join(root, 'missing'), cgroup), false);
});
