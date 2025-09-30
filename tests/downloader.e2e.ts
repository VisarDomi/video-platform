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
const GLOBAL_TEST_TIMEOUT = 120000; // 2 minutes for the whole suite

// --- Test Helper Functions ---

interface DownloadAssets {
    segmentFolderPath: string;
    growingTsPath: string;
}

async function waitForDownloadAssets(storagePath: string, targetSegmentCount: number): Promise<DownloadAssets> {
    const pollInterval = 1000;
    const maxWaitTime = 45000;
    let elapsedTime = 0;

    while (elapsedTime < maxWaitTime) {
        const entries = await fs.readdir(storagePath, { withFileTypes: true });
        const downloadFolders = entries.filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2} \d{6} .+/ .test(e.name));

        for (const folder of downloadFolders) {
            const folderPath = path.join(storagePath, folder.name);
            const growingTsPath = path.join(storagePath, `${folder.name}.ts`);
            
            const growingTsExists = await fs.access(growingTsPath).then(() => true).catch(() => false);
            
            if (growingTsExists) {
                const segments = await fs.readdir(folderPath);
                const tsFiles = segments.filter(f => f.endsWith('.ts'));

                if (tsFiles.length >= targetSegmentCount) {
                    console.log(`✅ Found valid asset pair for ${folder.name} with ${tsFiles.length} segments.`);
                    return {
                        segmentFolderPath: folderPath,
                        growingTsPath: growingTsPath,
                    };
                }
            }
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
    }
    throw new Error(`Timed out after ${maxWaitTime / 1000}s waiting for a download with ${targetSegmentCount} segment file(s).`);
}

async function waitForFileState(dir: string, mp4Name: string, rawFolderName: string, rawTsName: string): Promise<void> {
    const pollInterval = 1000;
    const maxWaitTime = 30000;
    let elapsedTime = 0;

    while (elapsedTime < maxWaitTime) {
        const mp4Exists = await fs.access(path.join(dir, mp4Name)).then(() => true).catch(() => false);
        const rawFolderExists = await fs.access(path.join(dir, rawFolderName)).then(() => true).catch(() => false);
        const rawTsExists = await fs.access(path.join(dir, rawTsName)).then(() => true).catch(() => false);

        if (mp4Exists && !rawFolderExists && !rawTsExists) {
            console.log('✅ Repackage and cleanup successful: MP4 exists and raw files are deleted.');
            return;
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
    }
    throw new Error('Timed out waiting for repackager to create MP4 and delete raw files.');
}


// --- Test Scenarios ---

async function testDownloadInProgress(tempDir: string): Promise<string> {
    console.log('\n--- Scenario 1: Verifying Active Download ---');
    let appProcess: ChildProcess | null = null;
    const tempConfigPath = path.join(tempDir, 'config.json');

    try {
        const tempConfig: Partial<any> = {
            storagePath: tempDir,
            repackager: { enabled: false },
            fileNames: { session: path.join(rootDir, 'session.json') }
        };
        await fs.writeFile(tempConfigPath, JSON.stringify(tempConfig));

        appProcess = spawn('node', [APP_ENTRY], { cwd: tempDir, stdio: 'pipe' });

        appProcess.stdout?.on('data', data => {
            const output = data.toString();
            process.stdout.write(output);
        });

        console.log('Waiting for download to start and write at least 3 segments...');
        const { segmentFolderPath, growingTsPath } = await waitForDownloadAssets(tempDir, 3);
        const downloadFolderName = path.basename(segmentFolderPath);
        
        console.log('✅ Assertion PASSED: At least 3 segment files were created.');

        const initialStats = await fs.stat(growingTsPath);
        console.log(`Initial size of ${path.basename(growingTsPath)}: ${initialStats.size} bytes. Waiting to verify growth...`);
        
        await new Promise(resolve => setTimeout(resolve, 5000));

        const finalStats = await fs.stat(growingTsPath);
        console.log(`Final size of ${path.basename(growingTsPath)}: ${finalStats.size} bytes.`);
        
        assert.ok(finalStats.size > initialStats.size, 'The main .ts file did not grow in size.');
        console.log('✅ Assertion PASSED: Concatenated .ts file is growing.');

        return downloadFolderName;

    } finally {
        if (appProcess) {
            console.log('Terminating download process to simulate stream ending...');
            appProcess.kill('SIGTERM');
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function testFullLifecycle(tempDir: string, staleFolderName: string) {
    console.log('\n--- Scenario 2: Verifying Repackage and Cleanup ---');
    let appProcess: ChildProcess | null = null;
    const tempConfigPath = path.join(tempDir, 'config.json');

    try {
        const tempConfig: Partial<any> = {
            storagePath: tempDir,
            downloader: { enabled: false },
            repackager: {
                enabled: true,
                deleteRawOnSuccess: true
            },
            fileNames: { session: path.join(rootDir, 'session.json') },
            timeouts: { staleStream: 5000 },
            intervals: { repackageScanMinutes: 0.1 }
        };
        await fs.writeFile(tempConfigPath, JSON.stringify(tempConfig, null, 2));

        console.log(`Relaunching app. Expecting it to find and process stale folder: ${staleFolderName}`);
        appProcess = spawn('node', [APP_ENTRY], { cwd: tempDir, stdio: 'pipe' });
        
        appProcess.stdout?.on('data', data => process.stdout.write(data.toString()));
        appProcess.stderr?.on('data', data => process.stderr.write(data.toString()));
        
        const mp4Name = `${staleFolderName}.mp4`;
        const rawTsName = `${staleFolderName}.ts`;

        console.log('Waiting for repackager to complete its work...');
        await waitForFileState(tempDir, mp4Name, staleFolderName, rawTsName);

        console.log('✅ Assertion PASSED: Lifecycle complete.');

    } finally {
        if (appProcess) appProcess.kill('SIGTERM');
    }
}


// --- Main Test Runner ---

async function main() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'downloader-suite-'));
    let staleFolderName: string | null = null;
    
    const timeout = setTimeout(() => {
        console.error(`\n--- E2E TEST SUITE TIMED OUT AFTER ${GLOBAL_TEST_TIMEOUT / 1000}s ---`);
        process.exit(1);
    }, GLOBAL_TEST_TIMEOUT);

    try {
        console.log(`--- Starting E2E Test Suite in ${tempDir} ---`);
        
        staleFolderName = await testDownloadInProgress(tempDir);
        
        if (staleFolderName) {
            // --> FIX: Clean up the "dirty" state file left by the killed process.
            console.log('Simulating clean restart by deleting live-status.json...');
            const statusFilePath = path.join(tempDir, 'live-status.json');
            await fs.rm(statusFilePath, { force: true }); // Use force:true to avoid errors if it doesn't exist for any reason.

            await testFullLifecycle(tempDir, staleFolderName);
        } else {
            throw new Error('First test scenario failed to produce a folder for the second scenario.');
        }

        console.log('\n✅✅✅ All E2E test scenarios PASSED! ✅✅✅');
        process.exit(0);

    } catch (error) {
        console.error('\n--- E2E Test Suite FAILED ---');
        console.error(error);
        process.exit(1);
    } finally {
        clearTimeout(timeout);
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log('Global temporary directory cleaned up.');
    }
}

main();