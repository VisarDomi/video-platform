// tests/e2e.ts
import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as url from "url";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const APP_ENTRY = path.join(rootDir, "dist", "main.js");
const TEST_TIMEOUT = 60000; // 60 seconds

interface TestConfig {
    testName: string;
    successLog: string | RegExp;
    failureLog?: string | RegExp;
    timeout?: number;
}

/**
 * A generic helper to run an E2E test scenario.
 */
function runTest(config: TestConfig): Promise<void> {
    const { testName, successLog, failureLog, timeout = TEST_TIMEOUT } = config;
    let appProcess: ChildProcess | null = null;
    let logBuffer = "";

    console.log(`\n--- Starting E2E Test: ${testName} ---`);

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const error = new Error(`Test timed out after ${timeout / 1000}s. Did not find success log: "${successLog}"`);
            console.error("--- LOG BUFFER ON TIMEOUT ---");
            console.error(logBuffer);
            console.error("-----------------------------");
            cleanupAndReject(error);
        }, timeout);

        const cleanupAndReject = (error: Error) => {
            clearTimeout(timer);
            if (appProcess) {
                console.log(`Step 5: Tearing down application process...`);
                appProcess.kill("SIGTERM");
                appProcess = null;
            }
            reject(error);
        };

        console.log(`--- Scenario: ${testName} ---`);
        console.log(`Using existing token from session.json...`);

        console.log(`\nStep 2: Launching the application...`);
        appProcess = spawn("node", [APP_ENTRY], { cwd: rootDir });

        console.log(`\nStep 3: Monitoring logs...`);

        appProcess.stdout?.on("data", (data) => {
            const output = data.toString();
            process.stdout.write(output);
            logBuffer += output;

            if (output.match(successLog)) {
                clearTimeout(timer);
                console.log(`\n--- E2E Test PASSED: ${testName} ---`);
                if (appProcess) {
                    console.log(`\nStep 5: Tearing down application process...`);
                    appProcess.kill("SIGTERM");
                    appProcess = null;
                }
                resolve();
            } else if (failureLog && output.match(failureLog)) {
                cleanupAndReject(new Error(`Detected failure log: "${failureLog}"`));
            }
        });

        appProcess.stderr?.on("data", (data) => {
            const errorOutput = data.toString();
            process.stderr.write(errorOutput);
            logBuffer += errorOutput;
        });

        appProcess.on("close", (code) => {
            if (code !== 0 && code !== null) {
                cleanupAndReject(new Error(`Application exited prematurely with code ${code}`));
            }
        });

        appProcess.on("error", (err) => {
            cleanupAndReject(new Error(`Failed to start application: ${err.message}`));
        });
    });
}

/**
 * Main test runner function
 */
async function main() {
    const allTests: TestConfig[] = [
        {
            testName: "Token Refresh",
            successLog: "Session successfully refreshed using token from file.",
            failureLog: "Failed to refresh session",
            timeout: 15000, // This should be fast
        },
        {
            testName: "Stream Download",
            successLog: "started downloading.",
            failureLog: "Failed to poll for following streams",
        },
    ];

    const testNameToRun = process.env.E2E_TEST_NAME;
    let testsToRun = allTests;

    if (testNameToRun) {
        testsToRun = allTests.filter((test) => test.testName === testNameToRun);
        if (testsToRun.length === 0) {
            console.error(`\n❌ Error: No E2E test found with the name "${testNameToRun}"`);
            console.error(`Available tests are: ${allTests.map((t) => `'${t.testName}'`).join(", ")}`);
            process.exit(1);
        }
        console.log(`🎯 Running targeted E2E test: ${testNameToRun}`);
    }

    try {
        for (const testConfig of testsToRun) {
            await runTest(testConfig);
        }

        console.log("\n✅ All executed E2E tests passed! ✅");
        process.exit(0);
    } catch (error: any) {
        console.error(`\n--- E2E Test FAILED ---`);
        console.error(error.message);
        process.exit(1);
    }
}

main();
