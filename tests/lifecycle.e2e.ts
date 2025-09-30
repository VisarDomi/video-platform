// tests/lifecycle.e2e.ts
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
const GLOBAL_TEST_TIMEOUT = 180000; // 3 minutes for the whole suite
const PROCESSED_FILE_TRACKER = path.join(rootDir, 'processed-by-combiner.txt');


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

async function waitForRepackagedFile(dir: string, mp4Name: string, rawFolderName: string, rawTsName: string): Promise<void> {
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
    throw new Error('Timed out waiting for assembler to create MP4 and delete raw files.');
}

async function waitForCombinedFile(storageDir: string, alias: string, sourceFiles: string[]): Promise<{ combinedFilePath: string }> {
    const pollInterval = 1000;
    const maxWaitTime = 30000;
    let elapsedTime = 0;

    while (elapsedTime < maxWaitTime) {
        const entries = await fs.readdir(storageDir, { withFileTypes: true });
        const combinedFile = entries.find(e => e.isFile() && e.name.includes(alias) && e.name.includes('min.mp4'));
        
        if (combinedFile) {
            const combinedFilePath = path.join(storageDir, combinedFile.name);
            console.log(`✅ Found combined file: ${combinedFile.name}`);

            const trashDir = path.join(storageDir, 'trash');
            let sourcesInTrash = 0;
            try {
                const trashEntries = await fs.readdir(trashDir);
                for (const sourceFile of sourceFiles) {
                    if (trashEntries.includes(sourceFile)) {
                        sourcesInTrash++;
                    }
                }
            } catch (e) { /* trash may not exist yet */ }

            if (sourcesInTrash === sourceFiles.length) {
                console.log('✅ All source files moved to trash.');
                return { combinedFilePath };
            }
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
    }
    throw new Error(`Timed out waiting for combiner to create a combined MP4 for alias '${alias}' and clean up source files.`);
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
            combiner: { enabled: false },
            fileNames: { session: path.join(rootDir, 'session.json') }
        };
        await fs.writeFile(tempConfigPath, JSON.stringify(tempConfig));

        appProcess = spawn('node', [APP_ENTRY], { cwd: tempDir, stdio: 'pipe' });
        appProcess.stdout?.on('data', data => process.stdout.write(data.toString()));

        console.log('Waiting for download to start and write at least 3 segments...');
        const { segmentFolderPath, growingTsPath } = await waitForDownloadAssets(tempDir, 3);
        const downloadFolderName = path.basename(segmentFolderPath);
        
        console.log('✅ Assertion PASSED: At least 3 segment files were created.');

        const initialStats = await fs.stat(growingTsPath);
        await new Promise(resolve => setTimeout(resolve, 5000));
        const finalStats = await fs.stat(growingTsPath);
        
        assert.ok(finalStats.size > initialStats.size, `The main .ts file did not grow in size. Initial: ${initialStats.size}, Final: ${finalStats.size}`);
        console.log('✅ Assertion PASSED: Concatenated .ts file is growing.');

        return downloadFolderName;

    } finally {
        if (appProcess) {
            console.log('Terminating download process to simulate stream ending...');
            appProcess.kill('SIGTERM');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

async function testRepackageAndCleanup(tempDir: string, staleFolderName: string) {
    console.log('\n--- Scenario 2: Verifying Repackage and Cleanup ---');
    let appProcess: ChildProcess | null = null;
    const tempConfigPath = path.join(tempDir, 'config.json');

    try {
        const tempConfig: Partial<any> = {
            storagePath: tempDir,
            downloader: { enabled: false },
            repackager: { enabled: true, deleteRawOnSuccess: true },
            combiner: { enabled: false },
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

        console.log('Waiting for assembler to complete its work...');
        await waitForRepackagedFile(tempDir, mp4Name, staleFolderName, rawTsName);

        console.log('✅ Assertion PASSED: Repackage lifecycle complete.');

    } finally {
        if (appProcess) appProcess.kill('SIGTERM');
    }
}

async function testCombination(tempDir: string, staleFolderName: string) {
    console.log('\n--- Scenario 3: Verifying Combination and Cleanup ---');
    let appProcess: ChildProcess | null = null;
    const tempConfigPath = path.join(tempDir, 'config.json');

    const nameParts = staleFolderName.match(/^(\d{4}-\d{2}-\d{2} \d{6}) (.+)$/);
    assert.ok(nameParts && nameParts[1] && nameParts[2], `Could not parse folder name: ${staleFolderName}`);
    const datePart = nameParts[1];
    const alias = nameParts[2];
    
    const firstMp4Name = `${staleFolderName}.mp4`;
    const secondMp4Name = `${datePart.slice(0, 13)}100 ${alias}.mp4`; // e.g., 120000 -> 120100

    try {
        // --- ARRANGE ---
        console.log('Arranging files for combination test...');
        const firstMp4Path = path.join(tempDir, firstMp4Name);
        const secondMp4Path = path.join(tempDir, secondMp4Name);
        await fs.copyFile(firstMp4Path, secondMp4Path);
        console.log(`Created two source files: ${firstMp4Name}, ${secondMp4Name}`);
        const sourceFiles = [firstMp4Name, secondMp4Name];
        
        // --- ACT ---
        const tempConfig: Partial<any> = {
            storagePath: tempDir,
            downloader: { enabled: false },
            repackager: { enabled: false },
            combiner: { enabled: true, scanIntervalHours: 0.001 }, // ~3.6 seconds
            fileNames: { session: path.join(rootDir, 'session.json') }
        };
        await fs.writeFile(tempConfigPath, JSON.stringify(tempConfig, null, 2));

        console.log('Relaunching app with only combiner enabled...');
        appProcess = spawn('node', [APP_ENTRY], { cwd: tempDir, stdio: 'pipe' });
        appProcess.stdout?.on('data', data => process.stdout.write(data.toString()));
        appProcess.stderr?.on('data', data => process.stderr.write(data.toString()));

        console.log('Waiting for combiner to complete its work...');
        await waitForCombinedFile(tempDir, alias, sourceFiles);
        
        // --- ASSERT ---
        console.log('✅ Assertion PASSED: Combined MP4 was created and sources were trashed.');

        for (const sourceFile of sourceFiles) {
            await assert.rejects(fs.access(path.join(tempDir, sourceFile)), { code: 'ENOENT' });
        }
        console.log('✅ Assertion PASSED: Source files were removed from storage root.');

        const processedContent = await fs.readFile(PROCESSED_FILE_TRACKER, 'utf-8');
        for (const sourceFile of sourceFiles) {
            assert.ok(processedContent.includes(sourceFile), `Tracker should contain ${sourceFile}`);
        }
        console.log('✅ Assertion PASSED: Processed file tracker is updated correctly.');
        console.log('✅ Assertion PASSED: Combination lifecycle complete.');

    } finally {
        if (appProcess) appProcess.kill('SIGTERM');
    }
}


// --- Main Test Runner ---

async function main() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lifecycle-suite-'));
    let staleFolderName: string | null = null;
    
    const timeout = setTimeout(() => {
        console.error(`\n--- E2E TEST SUITE TIMED OUT AFTER ${GLOBAL_TEST_TIMEOUT / 1000}s ---`);
        process.exit(1);
    }, GLOBAL_TEST_TIMEOUT);

    try {
        console.log(`--- Starting E2E Test Suite in ${tempDir} ---`);
        await fs.rm(PROCESSED_FILE_TRACKER, { force: true });
        
        // SCENARIO 1: Download
        staleFolderName = await testDownloadInProgress(tempDir);
        
        console.log('Simulating clean restart by deleting live-status.json...');
        await fs.rm(path.join(tempDir, 'live-status.json'), { force: true });

        // SCENARIO 2: Assemble
        await testRepackageAndCleanup(tempDir, staleFolderName);
        
        // SCENARIO 3: Combine
        await testCombination(tempDir, staleFolderName);

        console.log('\n✅✅✅ All E2E test scenarios PASSED! ✅✅✅');
        process.exit(0);

    } catch (error) {
        console.error('\n--- E2E Test Suite FAILED ---');
        console.error(error);
        process.exit(1);
    } finally {
        clearTimeout(timeout);
        await fs.rm(PROCESSED_FILE_TRACKER, { force: true });
        await fs.rm(tempDir, { recursive: true, force: true });
        console.log('Global temporary directory and state files cleaned up.');
    }
}

main();