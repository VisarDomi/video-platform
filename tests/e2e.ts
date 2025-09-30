// tests/e2e.ts
import * as child_process from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// --- Configuration ---
const SESSION_FILE = 'session.json';
const STATUS_FILE = 'live-status.json';
const ERROR_LOG = 'error.log';

interface TestScenario {
    name: string;
    logSuccessMessage: string;
    timeout: number;
    preRun?: () => Promise<void>; // Optional setup function
    postRun?: () => Promise<void>; // Optional verification function
    failureCondition?: (log: string) => boolean; // Optional check for wrong behavior
}

// --- Test Scenarios Definition ---

const FreshLoginScenario: TestScenario = {
    name: "Fresh Login (Puppeteer)",
    logSuccessMessage: 'Initial authentication successful.',
    timeout: 3 * 60 * 1000, // 3 minutes
    preRun: async () => {
        console.log('--- Scenario: Fresh Login ---');
        console.log('Ensuring clean slate by deleting old session files...');
        for (const file of [SESSION_FILE, STATUS_FILE, ERROR_LOG]) {
            try {
                await fs.rm(path.resolve(process.cwd(), file));
            } catch (error: any) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
    },
    postRun: async () => {
        console.log('Verifying session files were created from scratch...');
        const sessionData = JSON.parse(await fs.readFile(SESSION_FILE, 'utf-8'));
        if (!sessionData.tangoRT || typeof sessionData.tangoRT !== 'string') {
            throw new Error(`${SESSION_FILE} is missing 'tangoRT' property.`);
        }
        console.log(`  - Verified ${SESSION_FILE}`);
    }
};

const RefreshScenario: TestScenario = {
    name: "Token Refresh",
    logSuccessMessage: 'Session successfully refreshed using token from file.',
    timeout: 1 * 60 * 1000, // 1 minute
    preRun: async () => {
        console.log('--- Scenario: Token Refresh ---');
        console.log(`Using existing token from ${SESSION_FILE}...`);
        // Clean up status file to ensure we're testing its creation on refresh
        try { await fs.rm(STATUS_FILE); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    },
    failureCondition: (log: string) => {
        return log.includes('Launching browser for automatic login');
    }
};

// --- Test Runner ---

async function runTest(scenario: TestScenario) {
    console.log(`\n--- Starting E2E Test: ${scenario.name} ---`);
    let appProcess: child_process.ChildProcess | null = null;

    try {
        // 1. Run scenario-specific setup
        if (scenario.preRun) {
            await scenario.preRun();
        }

        // 2. Launch the Application
        console.log('\nStep 2: Launching the application...');
        appProcess = child_process.spawn('node', ['--loader', 'ts-node/esm', 'src/main.ts']);

        // 3. Monitor Logs
        console.log(`\nStep 3: Monitoring logs...`);
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`Test timed out after ${scenario.timeout / 1000}s.`)), scenario.timeout);

            const onData = (data: Buffer) => {
                const log = data.toString();
                process.stdout.write(log); // Show app logs in real-time

                if (scenario.failureCondition?.(log)) {
                    clearTimeout(timeout);
                    reject(new Error("FAILURE: A failure condition was met. Check logs."));
                }
                if (log.includes(scenario.logSuccessMessage)) {
                    clearTimeout(timeout);
                    resolve();
                }
            };
            appProcess?.stdout?.on('data', onData);
            appProcess?.stderr?.on('data', onData);
            appProcess?.on('close', (code) => {
                clearTimeout(timeout);
                reject(new Error(`Application exited prematurely with code ${code}`));
            });
        });

        // 4. Run scenario-specific verification
        if (scenario.postRun) {
            await scenario.postRun();
        }
        
        console.log(`\n--- E2E Test PASSED: ${scenario.name} ---`);
    } catch (error) {
        console.error(`\n--- E2E Test FAILED: ${scenario.name} ---`);
        console.error(error);
        process.exit(1);
    } finally {
        if (appProcess) {
            console.log('\nStep 5: Tearing down application process...');
            appProcess.kill();
        }
    }
}

// --- Main Execution Logic ---
async function main() {
    try {
        const sessionFileContent = await fs.readFile(SESSION_FILE, 'utf-8');
        const sessionData = JSON.parse(sessionFileContent);
        if (sessionData && sessionData.tangoRT) {
            // If we have a token, run the refresh test
            await runTest(RefreshScenario);
        } else {
            // If token is invalid or file is malformed, run fresh login
            await runTest(FreshLoginScenario);
        }
    } catch (error: any) {
        // If file doesn't exist (ENOENT), it's a fresh login
        if (error.code === 'ENOENT') {
            await runTest(FreshLoginScenario);
        } else {
            // Any other error reading the file is a failure
            console.error(`Failed to read or parse ${SESSION_FILE}.`, error);
            process.exit(1);
        }
    }
}

main();