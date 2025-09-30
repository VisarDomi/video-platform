// tests/repackager.e2e.ts
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as url from 'url';
import assert from 'assert';
import winston from 'winston';
import TransportStream from 'winston-transport';

import { repackageFolder } from '../dist/repackager.js';
import logger from '../dist/logger.js';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const fixturesDir = path.join(rootDir, 'tests', 'fixtures');

/**
 * A custom Winston transport to capture logs in memory for assertion.
 * This now correctly extends the base class from `winston-transport`.
 */
class MemoryTransport extends TransportStream { // <-- EXTEND THE CORRECT CLASS
    public logs: string[] = [];

    // The `info` object has a special symbol property for the message.
    log(info: any, callback: () => void) {
        this.logs.push(info[Symbol.for('message')]);
        callback();
    }
}

async function runRepackagingTest() {
    console.log('\n--- Starting E2E Test: Repackaging Logic ---');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repack-test-'));
    const downloadFolderName = '2025-01-01 120000 test-streamer';
    const downloadFolderPath = path.join(tempDir, downloadFolderName);
    const memoryTransport = new MemoryTransport();
    
    try {
        // --- 1. ARRANGE ---
        console.log(`Setting up test in temporary directory: ${tempDir}`);
        await fs.mkdir(downloadFolderPath);

        console.log('Copying test fixtures...');
        await fs.copyFile(path.join(fixturesDir, 'good_segment.ts'), path.join(downloadFolderPath, '1.ts'));
        await fs.copyFile(path.join(fixturesDir, 'corrupted_segment.ts'), path.join(downloadFolderPath, '2.ts'));
        await fs.copyFile(path.join(fixturesDir, 'bad_resolution.ts'), path.join(downloadFolderPath, '3.ts'));
        await fs.writeFile(path.join(downloadFolderPath, '4.ts'), ''); // 0-byte file
        await fs.copyFile(path.join(fixturesDir, 'good_segment_2.ts'), path.join(downloadFolderPath, '5.ts'));
        
        logger.add(memoryTransport);
        console.log('Test fixtures prepared. Running repackager...');

        // --- 2. ACT ---
        await repackageFolder(downloadFolderPath);
        console.log('Repackager finished.');

        // --- 3. ASSERT ---
        console.log('Verifying results...');
        const logs = memoryTransport.logs.join('\n');

        // Assertion 1: Corrupted file
        assert.ok(logs.includes('Skipping segment (CORRUPTED): 2.ts'), 'Did not log skipping of corrupted segment.');
        console.log('✅ Assertion PASSED: Corrupted segment was logged as skipped.');

        // Assertion 2: Bad resolution file
        assert.ok(logs.includes('Skipping segment (RESOLUTION_MISMATCH (360x640)): 3.ts'), 'Did not log skipping of bad resolution segment.');
        console.log('✅ Assertion PASSED: Bad resolution segment was logged as skipped.');

        // Assertion 3: 0-byte file
        assert.ok(logs.includes('Skipping segment (CORRUPTED): 4.ts'), 'Did not log skipping of 0-byte segment.');
        console.log('✅ Assertion PASSED: 0-byte segment was logged as skipped.');

        // Assertion 4: Final summary log
        assert.ok(logs.includes('Validation complete: 2 good, 3 skipped.'), 'Final validation summary log is incorrect.');
        console.log('✅ Assertion PASSED: Final validation count is correct.');
        
        // Assertion 5: Final MP4 file was created
        const finalMp4Path = path.join(tempDir, `${downloadFolderName}.mp4`);
        await fs.access(finalMp4Path);
        console.log('✅ Assertion PASSED: Final MP4 file exists.');

        console.log('\n--- E2E Test PASSED: Repackaging Logic ---');

    } catch (error) {
        console.error('\n--- E2E Test FAILED: Repackaging Logic ---');
        console.error(error);
        process.exit(1);
    } finally {
        // --- 4. TEARDOWN ---
        logger.remove(memoryTransport);
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log('Temporary test directory cleaned up.');

        // --- 5. EXIT ---
        process.exit(0);
    }
}

runRepackagingTest();