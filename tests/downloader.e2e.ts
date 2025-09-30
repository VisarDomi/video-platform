// tests/downloader.e2e.ts
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as url from 'url';
import assert from 'assert';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const APP_ENTRY = path.join(rootDir, 'dist', 'main.js');
const TEST_TIMEOUT = 90000; // 90 seconds, allowing time for stream discovery and segment download

async function waitForSegments(storagePath: string): Promise<string> {
    const pollInterval = 1000;
    const maxWaitTime = 30000;
    let elapsedTime = 0;

    while (elapsedTime < maxWaitTime) {
        const entries = await fs.readdir(storagePath, { withFileTypes: true });
        const downloadFolder = entries.find(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2} \d{6} .+/ .test(e.name));

        if (downloadFolder) {
            const downloadFolderPath = path.join(storagePath, downloadFolder.name);
            const segments = await fs.readdir(downloadFolderPath);
            if (segments.some(f => f.endsWith('.ts'))) {
                console.log(`✅ Segment file(s) found in ${downloadFolder.name}.`);
                return downloadFolderPath;
            }
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
    }

    throw new Error(`Timed out after ${maxWaitTime / 1000}s waiting for segment files.`);
}

async function runDownloaderTest() {
    console.log('\n--- Starting E2E Test: Live Stream Download ---');
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'downloader-test-'));
    const tempConfigPath = path.join(tempDir, 'config.json');

    let appProcess: ChildProcess | null = null;
    let logBuffer = '';

    const cleanup = async () => {
        if (appProcess) {
            console.log('Tearing down application process...');
            appProcess.kill('SIGTERM');
            appProcess = null;
        }
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log('Temporary test directory and config cleaned up.');
    };

    try {
        // --- 1. ARRANGE ---
        console.log(`Setting up test in temporary directory: ${tempDir}`);

        const tempConfig: Partial<any> = {
            storagePath: tempDir,
            repackager: { enabled: false },
            // --> FIX: Point directly to the root session.json file using an absolute path.
            fileNames: {
                session: path.join(rootDir, 'session.json')
            }
        };
        await fs.writeFile(tempConfigPath, JSON.stringify(tempConfig));

        // --- 2. ACT ---
        console.log('Launching the application...');
        appProcess = spawn('node', [APP_ENTRY], { cwd: tempDir });

        const testPromise = new Promise<void>((resolve, reject) => {
            appProcess?.stdout?.on('data', (data) => {
                const output = data.toString();
                process.stdout.write(output);
                logBuffer += output;
                if (output.match(/started downloading\./)) {
                    resolve();
                }
            });
            appProcess?.stderr?.on('data', (data) => {
                const errorOutput = data.toString();
                process.stderr.write(errorOutput);
                logBuffer += errorOutput;
            });
            appProcess?.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    reject(new Error(`Application exited prematurely with code ${code}`));
                }
            });
            appProcess?.on('error', (err) => {
                reject(new Error(`Failed to start application: ${err.message}`));
            });
        });

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => {
                console.error('--- LOG BUFFER ON TIMEOUT ---');
                console.error(logBuffer);
                console.error('-----------------------------');
                reject(new Error(`Test timed out after ${TEST_TIMEOUT / 1000}s.`));
            }, TEST_TIMEOUT)
        );

        await Promise.race([testPromise, timeoutPromise]);
        
        // --- 3. ASSERT ---
        console.log('Verifying results...');
        assert.ok(logBuffer.match(/started downloading\./), 'Did not find "started downloading" log message.');
        console.log('✅ Assertion PASSED: "started downloading" log found.');

        console.log('Waiting for segment files to be created...');
        const downloadFolderPath = await waitForSegments(tempDir);
        const segments = await fs.readdir(downloadFolderPath);
        const tsFiles = segments.filter(f => f.endsWith('.ts'));
        assert.ok(tsFiles.length > 0, 'No .ts segment files were found in the download directory.');
        console.log(`✅ Assertion PASSED: Found ${tsFiles.length} segment file(s).`);

        console.log('\n--- E2E Test PASSED: Live Stream Download ---');
        process.exit(0);

    } catch (error) {
        console.error('\n--- E2E Test FAILED: Live Stream Download ---');
        console.error(error);
        process.exit(1);
    } finally {
        await cleanup();
    }
}

runDownloaderTest();