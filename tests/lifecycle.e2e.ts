// tests/lifecycle.e2e.ts
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import 'dotenv/config';

// --- Test Configuration ---
const TEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes overall timeout for the test
const DOWNLOAD_DURATION_S = 60; // How long to let the download run
const MIN_EXPECTED_SEGMENTS = 50; // Minimum .ts files after DOWNLOAD_DURATION_S
const COMBINER_SETUP_COPIES = 20; // Number of copies for the combiner test

// --- Global Variables ---
let appProcess: ChildProcess | null = null;
let config: any; // Will hold the content of config.json

// --- Helper Functions ---

/**
 * Reads and parses the main config.json file.
 */
async function getAppConfig() {
    const configRaw = await fs.readFile('config.json', 'utf-8');
    return JSON.parse(configRaw);
}

/**
 * Deletes all artifacts created during the test run to ensure a clean slate.
 */
async function cleanup() {
    console.log('[Cleanup] Removing test artifacts...');
    if (!config) config = await getAppConfig();
    const projectRoot = process.cwd();
    const filesToDelete = [
        config.fileNames.liveStatus,
        config.fileNames.errorLog,
        'processed-by-combiner.txt',
    ];
    for (const file of filesToDelete) {
        await fs.rm(path.join(projectRoot, file), { force: true });
    }
    await fs.rm(config.storagePath, { recursive: true, force: true });
    console.log('[Cleanup] Finished.');
}

/**
 * Starts the application as a child process and resolves when it's ready.
 * It streams the application's logs to the console for real-time feedback.
 */
function startApp(): Promise<ChildProcess> {
    console.log('[Test Runner] Starting application process...');
    return new Promise((resolve, reject) => {
        const proc = spawn('node', ['dist/main.js'], {
            cwd: process.cwd(),
            env: process.env,
        });

        let output = '';
        const onData = (data: Buffer) => {
            const str = data.toString();
            // Prefix app logs to distinguish them from test logs
            str.trim().split('\n').forEach(line => console.log(`[APP] ${line}`));
            output += str;
            // The app is considered "ready" once all services are confirmed running.
            if (output.includes('All enabled services are running')) {
                proc.stdout.removeListener('data', onData);
                proc.stderr.removeListener('data', onData);
                console.log('[Test Runner] Application is up and running.');
                resolve(proc);
            }
        };

        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.on('error', (err) => reject(new Error(`Failed to start app: ${err.message}`)));
        proc.on('exit', (code, signal) => {
            if (code !== 0 && signal !== 'SIGINT') {
                console.error(`[Test Runner] App process exited unexpectedly with code ${code}, signal ${signal}`);
            }
        });
    });
}

/**
 * Sends a SIGINT signal to the process and waits for it to exit gracefully.
 */
function gracefulShutdown(proc: ChildProcess): Promise<void> {
    console.log('[Test Runner] Sending graceful shutdown signal (SIGINT)...');
    return new Promise((resolve) => {
        proc.on('exit', () => {
            console.log('[Test Runner] Application process has exited.');
            resolve();
        });
        proc.kill('SIGINT'); // Simulates Ctrl+C
    });
}

/**
 * Waits for a file to exist at a given path.
 */
async function waitForFile(filePath: string, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        try {
            await fs.access(filePath);
            console.log(`[Check] Found file: ${path.basename(filePath)}`);
            return;
        } catch {
            await new Promise(res => setTimeout(res, 1000));
        }
    }
    throw new Error(`Timeout: File not found at ${filePath} after ${timeoutMs / 1000}s`);
}

/**
 * Checks if a file's size is increasing over a duration.
 */
async function checkFileSizeGrowth(filePath: string, durationMs: number): Promise<void> {
    console.log(`[Check] Monitoring file size growth for ${path.basename(filePath)} over ${durationMs / 1000}s...`);
    let lastSize = (await fs.stat(filePath)).size;
    await new Promise(res => setTimeout(res, durationMs));
    const finalSize = (await fs.stat(filePath)).size;

    if (finalSize > lastSize) {
        console.log(`[Check] PASSED: File grew from ${lastSize} to ${finalSize} bytes.`);
    } else {
        throw new Error(`[Check] FAILED: File size did not grow. Start: ${lastSize}, End: ${finalSize}`);
    }
}

/**
 * Finds the first subdirectory in a given directory, which should be the streamer's folder.
 */
async function findStreamerFolder(baseDir: string, timeoutMs: number = 30000): Promise<string> {
    console.log(`[Check] Searching for streamer download folder in: ${baseDir}`);
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
        const entries = await fs.readdir(baseDir, { withFileTypes: true });
        const subdirs = entries.filter(e => e.isDirectory() && e.name !== 'trash' && e.name !== 'edited');
        if (subdirs.length > 0) {
            const folderPath = path.join(baseDir, subdirs[0].name);
            console.log(`[Check] Found streamer folder: ${subdirs[0].name}`);
            return folderPath;
        }
        await new Promise(res => setTimeout(res, 2000));
    }
    throw new Error(`Timeout: No streamer download folder found in ${baseDir} after ${timeoutMs / 1000}s`);
}


/**
 * The main test execution flow.
 */
async function runTest() {
    console.log('--- E2E LIFECYCLE TEST: STARTING ---');
    config = await getAppConfig();

    // =================================================================
    // PHASE 1: AUTHENTICATION & DOWNLOADING
    // =================================================================
    console.log('\n--- PHASE 1: Testing Downloader ---');
    console.log('Ensure a valid session.json is in the project root.');
    appProcess = await startApp();

    const streamerDir = await findStreamerFolder(config.storagePath);
    const mainTsFile = path.join(config.storagePath, `${path.basename(streamerDir)}.ts`);
    
    // Concurrently check for file growth and wait for segments to accumulate
    const growthPromise = checkFileSizeGrowth(mainTsFile, DOWNLOAD_DURATION_S * 1000);
    const segmentWaitPromise = new Promise(res => setTimeout(res, DOWNLOAD_DURATION_S * 1000));
    await Promise.all([growthPromise, segmentWaitPromise]);

    const segments = (await fs.readdir(streamerDir)).filter(f => f.endsWith('.ts'));
    console.log(`[Check] Found ${segments.length} .ts segment files.`);
    if (segments.length < MIN_EXPECTED_SEGMENTS) {
        throw new Error(`Download test failed: Expected at least ${MIN_EXPECTED_SEGMENTS} segments, but found only ${segments.length}.`);
    }
    console.log('[Check] PASSED: Download ran successfully for 60 seconds.');

    await gracefulShutdown(appProcess);
    appProcess = null;
    console.log('--- PHASE 1: COMPLETE ---');


    // =================================================================
    // PHASE 2: ASSEMBLING
    // =================================================================
    console.log('\n--- PHASE 2: Testing Assembler ---');
    await fs.rm(path.join(process.cwd(), config.fileNames.liveStatus), { force: true });
    console.log('[Setup] Deleted live-status.json to ensure assembler processes the new folder.');

    appProcess = await startApp();

    const expectedMp4Path = path.join(config.storagePath, `${path.basename(streamerDir)}.mp4`);
    await waitForFile(expectedMp4Path);
    console.log(`[Check] PASSED: Assembler created ${path.basename(expectedMp4Path)}.`);

    // Check for cleanup
    try {
        await fs.access(streamerDir);
        throw new Error('[Check] FAILED: Assembler did not delete the source segment folder.');
    } catch (e: any) {
        if (e.code === 'ENOENT') {
            console.log('[Check] PASSED: Source segment folder was deleted.');
        } else throw e;
    }
    
    await gracefulShutdown(appProcess);
    appProcess = null;
    console.log('--- PHASE 2: COMPLETE ---');

    // =================================================================
    // PHASE 3: COMBINING
    // =================================================================
    console.log('\n--- PHASE 3: Testing Combiner ---');
    const editedDir = path.join(config.storagePath, 'edited');
    await fs.mkdir(editedDir, { recursive: true });
    await fs.rm(path.join(process.cwd(), 'processed-by-combiner.txt'), { force: true });

    console.log(`[Setup] Copying ${path.basename(expectedMp4Path)} ${COMBINER_SETUP_COPIES} times to trigger the combiner...`);
    for (let i = 0; i < COMBINER_SETUP_COPIES; i++) {
        const timestamp = new Date(Date.now() - i * 90000).toISOString()
            .replace(/T/, ' ').replace(/:/g, '').slice(0, 16);
        const parsedName = path.basename(expectedMp4Path).match(/^(\d{4}-\d{2}-\d{2} \d{6}) (.+)\.mp4$/);
        if (!parsedName) throw new Error("Could not parse MP4 filename for combiner setup.");
        const streamerName = parsedName[2];
        const newName = `${timestamp.replace("-", "").replace("-", "")} ${streamerName}.mp4`;
        await fs.copyFile(expectedMp4Path, path.join(editedDir, newName));
    }
    console.log(`[Setup] Copied ${COMBINER_SETUP_COPIES} files.`);

    appProcess = await startApp();

    // Wait for the combined file to appear. It will have "min.mp4" in the name.
    const combinedFilePromise = (async () => {
        while (true) {
            const files = await fs.readdir(editedDir);
            const combinedFile = files.find(f => f.includes('min.mp4'));
            if (combinedFile) {
                console.log(`[Check] Found combined file: ${combinedFile}`);
                return combinedFile;
            }
            await new Promise(res => setTimeout(res, 2000));
        }
    })();
    
    await combinedFilePromise;
    console.log('[Check] PASSED: Combiner created a new video file.');

    // The test gracefully exits after the first successful combine, as requested.
    await gracefulShutdown(appProcess);
    appProcess = null;
    console.log('--- PHASE 3: COMPLETE ---');

}

// --- Main Execution Block ---
(async () => {
    // Initial cleanup is crucial for a clean run
    try {
        config = await getAppConfig();
        await cleanup();
        // The user is responsible for providing session.json before this script runs.
        console.log("Copying provided session.json fixture to project root for test...")
        await fs.copyFile('tests/fixtures/session.json', 'session.json');
    } catch (e:any) {
        if(e.code !== 'ENOENT') { // It's okay if session.json fixture doesn't exist
            console.error("Error during initial cleanup:", e);
            process.exit(1);
        }
    }


    const testPromise = runTest();
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Test timed out after ${TEST_TIMEOUT_MS / 1000}s`)), TEST_TIMEOUT_MS)
    );

    try {
        await Promise.race([testPromise, timeoutPromise]);
        console.log('\n✅✅✅ E2E LIFECYCLE TEST SUCCEEDED ✅✅✅');
    } catch (error) {
        console.error('\n❌❌❌ E2E LIFECYCLE TEST FAILED ❌❌❌');
        console.error((error as Error).message);
        if (appProcess && !appProcess.killed) {
            console.log('Force killing hanging application process...');
            appProcess.kill('SIGKILL');
        }
        process.exit(1);
    } finally {
        await cleanup();
    }
})();