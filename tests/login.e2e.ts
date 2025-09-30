// tests/login.e2e.ts
import * as child_process from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// --- Configuration ---
const TEST_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes, Puppeteer can be slow
const LOG_SUCCESS_MESSAGE = 'Initial authentication successful.';
const LOG_WATCHING_MESSAGE = 'Watching for streams...';
const SESSION_FILE = 'session.json';
const STATUS_FILE = 'live-status.json';
const ERROR_LOG = 'error.log';

async function runLoginTest() {
    console.log('--- Starting E2E Login Test ---');
    let appProcess: child_process.ChildProcess | null = null;

    try {
        // --- 1. Cleanup: Ensure a clean slate for a fresh login ---
        console.log('Step 1: Cleaning up old session files...');
        for (const file of [SESSION_FILE, STATUS_FILE, ERROR_LOG]) {
            try {
                await fs.rm(path.resolve(process.cwd(), file));
                console.log(`  - Deleted ${file}`);
            } catch (error: any) {
                if (error.code !== 'ENOENT') throw error; // Ignore if file doesn't exist
            }
        }

        // --- 2. Launch the Application ---
        console.log('\nStep 2: Launching the application...');
        appProcess = child_process.spawn('node', [
            '--loader', 'ts-node/esm', 
            'src/main.ts'
        ], {
            env: { ...process.env, 'NODE_ENV': 'test' } // Pass environment variables
        });

        // --- 3. Monitor Logs for Success ---
        console.log(`\nStep 3: Monitoring logs for success message (Timeout: ${TEST_TIMEOUT_MS / 1000}s)...`);
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Test timed out after ${TEST_TIMEOUT_MS / 1000}s. App did not log success.`));
            }, TEST_TIMEOUT_MS);

            let authSuccess = false;
            let watchingSuccess = false;

            const onData = (data: Buffer) => {
                const log = data.toString();
                process.stdout.write(log); // Show app logs in real-time

                if (log.includes(LOG_SUCCESS_MESSAGE)) {
                    console.log('\n[TEST SUCCESS] Found initial auth success message!');
                    authSuccess = true;
                }
                if (log.includes(LOG_WATCHING_MESSAGE)) {
                    console.log('[TEST SUCCESS] Found stream watcher startup message!');
                    watchingSuccess = true;
                }

                if (authSuccess && watchingSuccess) {
                    clearTimeout(timeout);
                    resolve();
                }
            };
            appProcess?.stdout?.on('data', onData);
            appProcess?.stderr?.on('data', onData); // Also listen to stderr
            appProcess?.on('close', (code) => {
                clearTimeout(timeout);
                reject(new Error(`Application exited prematurely with code ${code}`));
            });
        });

        // --- 4. Verify File Creation ---
        console.log('\nStep 4: Verifying session files were created...');
        const sessionData = JSON.parse(await fs.readFile(SESSION_FILE, 'utf-8'));
        if (!sessionData.tangoRT || typeof sessionData.tangoRT !== 'string') {
            throw new Error(`${SESSION_FILE} is missing 'tangoRT' property.`);
        }
        console.log(`  - Verified ${SESSION_FILE}`);

        const statusData = JSON.parse(await fs.readFile(STATUS_FILE, 'utf-8'));
        if (!statusData.tokens || !statusData.tokens.st) {
            throw new Error(`${STATUS_FILE} is missing 'tokens.st' property.`);
        }
        console.log(`  - Verified ${STATUS_FILE}`);
        
        console.log('\n--- E2E Login Test PASSED ---');

    } catch (error) {
        console.error('\n--- E2E Login Test FAILED ---');
        console.error(error);
        process.exit(1); // Exit with a failure code
    } finally {
        // --- 5. Cleanup: Always kill the app process ---
        if (appProcess) {
            console.log('\nStep 5: Tearing down application process...');
            appProcess.kill();
        }
    }
}

runLoginTest();