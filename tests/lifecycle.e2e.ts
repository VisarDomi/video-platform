// tests/lifecycle.e2e.ts
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";
import * as url from "url";
import assert from "assert";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const APP_ENTRY = path.join(rootDir, "dist", "main.js");
const GLOBAL_TEST_TIMEOUT = 180000; // 3 minutes for the whole suite
const PROCESSED_FILE_TRACKER = path.join(rootDir, "processed-by-combiner.txt");

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
        const entries = await fsPromises.readdir(storagePath, { withFileTypes: true });
        const downloadFolders = entries.filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2} \d{6} .+/.test(e.name));

        for (const folder of downloadFolders) {
            const folderPath = path.join(storagePath, folder.name);
            const growingTsPath = path.join(storagePath, `${folder.name}.ts`);

            const growingTsExists = await fsPromises
                .access(growingTsPath)
                .then(() => true)
                .catch(() => false);

            if (growingTsExists) {
                const segments = await fsPromises.readdir(folderPath);
                const tsFiles = segments.filter((f) => f.endsWith(".ts"));

                if (tsFiles.length >= targetSegmentCount) {
                    console.log(`✅ Found valid asset pair for ${folder.name} with ${tsFiles.length} segments.`);
                    return {
                        segmentFolderPath: folderPath,
                        growingTsPath: growingTsPath,
                    };
                }
            }
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
    }
    throw new Error(`Timed out after ${maxWaitTime / 1000}s waiting for a download with ${targetSegmentCount} segment file(s).`);
}

async function waitForRepackagedFile(dir: string, mp4Name: string, rawFolderName: string, rawTsName: string): Promise<string> {
    const pollInterval = 1000;
    const maxWaitTime = 30000;
    let elapsedTime = 0;
    const mp4Path = path.join(dir, mp4Name);

    while (elapsedTime < maxWaitTime) {
        const mp4Exists = await fsPromises
            .access(mp4Path)
            .then(() => true)
            .catch(() => false);
        const rawFolderExists = await fsPromises
            .access(path.join(dir, rawFolderName))
            .then(() => true)
            .catch(() => false);
        const rawTsExists = await fsPromises
            .access(path.join(dir, rawTsName))
            .then(() => true)
            .catch(() => false);

        if (mp4Exists && !rawFolderExists && !rawTsExists) {
            console.log("✅ Repackage and cleanup successful: MP4 exists and raw files are deleted.");
            return mp4Path;
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
    }
    throw new Error("Timed out waiting for assembler to create MP4 and delete raw files.");
}

async function waitForCombinedFile(storageDir: string, alias: string, expectedSourceCount: number): Promise<{ combinedFilePath: string }> {
    const pollInterval = 1000;
    const maxWaitTime = 45000; // Increased timeout for more files
    let elapsedTime = 0;

    const editedDir = path.join(storageDir, "edited");

    while (elapsedTime < maxWaitTime) {
        let entries: fs.Dirent[] = [];
        try {
            entries = await fsPromises.readdir(editedDir, { withFileTypes: true });
        } catch (e) {
            /* edited dir might not exist yet, continue polling */
        }

        const combinedFile = entries.find((e) => e.isFile() && e.name.includes(alias) && e.name.includes("min.mp4"));

        if (combinedFile) {
            const combinedFilePath = path.join(editedDir, combinedFile.name);
            console.log(`✅ Found combined file: ${combinedFile.name}`);

            const trashDir = path.join(storageDir, "trash");
            let sourcesInTrash = 0;
            try {
                const trashEntries = await fsPromises.readdir(trashDir);
                sourcesInTrash = trashEntries.filter((f) => f.includes(alias) && f.endsWith(".mp4")).length;
            } catch (e) {
                /* trash may not exist yet */
            }

            if (sourcesInTrash >= expectedSourceCount) {
                console.log(`✅ Found ${sourcesInTrash} source files in trash, meeting expectation of ${expectedSourceCount}.`);
                return { combinedFilePath };
            }
        }

        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        elapsedTime += pollInterval;
    }
    throw new Error(`Timed out waiting for combiner to create a combined MP4 for alias '${alias}' and clean up source files.`);
}

// --- Test Scenarios ---

async function testDownloadInProgress(tempDir: string): Promise<string> {
    console.log("\n--- Scenario 1: Verifying Active Download ---");
    let appProcess: ChildProcess | null = null;
    const tempConfigPath = path.join(tempDir, "config.json");

    try {
        const tempConfig: Partial<any> = {
            storagePath: tempDir,
            repackager: { enabled: false },
            combiner: { enabled: false },
            fileNames: { session: path.join(rootDir, "session.json") },
        };
        await fsPromises.writeFile(tempConfigPath, JSON.stringify(tempConfig));

        appProcess = spawn("node", [APP_ENTRY], { cwd: tempDir, stdio: "pipe" });
        appProcess.stdout?.on("data", (data) => process.stdout.write(data.toString()));

        console.log("Waiting for download to start and write at least 3 segments...");
        const { segmentFolderPath } = await waitForDownloadAssets(tempDir, 3);
        const downloadFolderName = path.basename(segmentFolderPath);

        console.log("✅ Assertion PASSED: At least 3 segment files were created.");

        // Let it download a bit more to get a decent length video (~25-30s)
        await new Promise((resolve) => setTimeout(resolve, 10000));

        return downloadFolderName;
    } finally {
        if (appProcess) {
            console.log("Terminating download process to simulate stream ending...");
            appProcess.kill("SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }
}

async function testRepackageAndCleanup(tempDir: string, staleFolderName: string): Promise<string> {
    console.log("\n--- Scenario 2: Verifying Repackage and Cleanup ---");
    let appProcess: ChildProcess | null = null;
    const tempConfigPath = path.join(tempDir, "config.json");
    let createdMp4Path: string | null = null;

    try {
        const tempConfig: Partial<any> = {
            storagePath: tempDir,
            downloader: { enabled: false },
            repackager: { enabled: true, deleteRawOnSuccess: true },
            combiner: { enabled: false },
            fileNames: { session: path.join(rootDir, "session.json") },
            timeouts: { staleStream: 5000 },
            intervals: { repackageScanMinutes: 0.1 },
        };
        await fsPromises.writeFile(tempConfigPath, JSON.stringify(tempConfig, null, 2));

        console.log(`Relaunching app. Expecting it to find and process stale folder: ${staleFolderName}`);
        appProcess = spawn("node", [APP_ENTRY], { cwd: tempDir, stdio: "pipe" });
        appProcess.stdout?.on("data", (data) => process.stdout.write(data.toString()));
        appProcess.stderr?.on("data", (data) => process.stderr.write(data.toString()));

        const mp4Name = `${staleFolderName}.mp4`;
        const rawTsName = `${staleFolderName}.ts`;

        console.log("Waiting for assembler to complete its work...");
        createdMp4Path = await waitForRepackagedFile(tempDir, mp4Name, staleFolderName, rawTsName);

        console.log("✅ Assertion PASSED: Repackage lifecycle complete.");
        return createdMp4Path;
    } finally {
        if (appProcess) appProcess.kill("SIGTERM");
        if (!createdMp4Path) throw new Error("Repackaging did not produce an MP4 file path.");
    }
}

async function testCombination(tempDir: string, sourceMp4Path: string) {
    console.log("\n--- Scenario 3: Verifying Combination and Cleanup (Robust Test) ---");
    let appProcess: ChildProcess | null = null;

    const baseTestDir = path.join(tempDir, "combiner-test");
    const editedDir = path.join(baseTestDir, "edited");
    await fsPromises.mkdir(editedDir, { recursive: true });
    const tempConfigPath = path.join(baseTestDir, "config.json");

    const sourceMp4BaseName = path.basename(sourceMp4Path);
    const nameParts = sourceMp4BaseName.match(/^(\d{4}-\d{2}-\d{2} \d{6}) (.+?)\.mp4$/);
    assert.ok(nameParts && nameParts[1] && nameParts[2], `Could not parse MP4 name: ${sourceMp4BaseName}`);
    const datePart = nameParts[1];
    const alias = nameParts[2];

    try {
        // --- ARRANGE ---
        console.log(`Isolating test in: ${baseTestDir}, watching ${editedDir}`);
        const NUM_COPIES = 200; // Create a large number of files for a robust test.
        const sourceFilesToCreate: string[] = [];

        for (let i = 0; i < NUM_COPIES; i++) {
            // FIX: Create a valid ISO 8601 date string for the Date constructor.
            // '2025-09-30 190801' -> '2025-09-30T19:08:01Z'
            const isoDateTime = datePart.slice(0, 10) + "T" + datePart.slice(11, 13) + ":" + datePart.slice(13, 15) + ":" + datePart.slice(15, 17) + "Z";

            const newDate = new Date(isoDateTime);
            newDate.setSeconds(newDate.getSeconds() + i * 30); // Stagger timestamps

            const newDatePart = newDate.toISOString().slice(0, 19).replace("T", " ").replace(/:/g, "");
            const newMp4Name = `${newDatePart} ${alias}.mp4`;
            sourceFilesToCreate.push(newMp4Name);
            await fsPromises.copyFile(sourceMp4Path, path.join(editedDir, newMp4Name));
        }
        console.log(`Created ${NUM_COPIES} source files for user '${alias}' in 'edited' folder.`);

        // --- ACT ---
        const tempConfig: Partial<any> = {
            storagePath: baseTestDir,
            downloader: { enabled: false },
            repackager: { enabled: false },
            combiner: {
                enabled: true,
                scanIntervalHours: 0.001,
                minDurationMinutes: 15, // Use the real threshold
            },
            fileNames: { session: path.join(rootDir, "session.json") },
        };
        await fsPromises.writeFile(tempConfigPath, JSON.stringify(tempConfig, null, 2));

        console.log("Pausing briefly to ensure all files are written before starting app...");
        await new Promise((resolve) => setTimeout(resolve, 2000));

        console.log("Relaunching app with only combiner enabled...");
        appProcess = spawn("node", [APP_ENTRY], { cwd: baseTestDir, stdio: "pipe" });
        appProcess.stdout?.on("data", (data) => process.stdout.write(data.toString()));
        appProcess.stderr?.on("data", (data) => process.stderr.write(data.toString()));

        console.log("Waiting for combiner to complete its work...");
        // Expect at least 40 files to be combined to reach a 15-min threshold from ~20s videos.
        await waitForCombinedFile(baseTestDir, alias, 40);

        // --- ASSERT ---
        console.log("✅ Assertion PASSED: Combined MP4 was created and sources were trashed.");
    } finally {
        if (appProcess) appProcess.kill("SIGTERM");
    }
}

// --- Main Test Runner ---

async function main() {
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "lifecycle-suite-"));

    const timeout = setTimeout(() => {
        console.error(`\n--- E2E TEST SUITE TIMED OUT AFTER ${GLOBAL_TEST_TIMEOUT / 1000}s ---`);
        process.exit(1);
    }, GLOBAL_TEST_TIMEOUT);

    try {
        console.log(`--- Starting E2E Test Suite in ${tempDir} ---`);
        await fsPromises.rm(PROCESSED_FILE_TRACKER, { force: true });

        // SCENARIO 1: Download
        const staleFolderName = await testDownloadInProgress(tempDir);

        console.log("Simulating clean restart by deleting live-status.json...");
        await fsPromises.rm(path.join(tempDir, "live-status.json"), { force: true });

        // SCENARIO 2: Assemble
        const createdMp4Path = await testRepackageAndCleanup(tempDir, staleFolderName);

        // SCENARIO 3: Combine
        await testCombination(tempDir, createdMp4Path);

        console.log("\n✅✅✅ All E2E test scenarios PASSED! ✅✅✅");
        process.exit(0);
    } catch (error) {
        console.error("\n--- E2E Test Suite FAILED ---");
        console.error(error);
        process.exit(1);
    } finally {
        clearTimeout(timeout);
        await fsPromises.rm(PROCESSED_FILE_TRACKER, { force: true });
        await fsPromises.rm(tempDir, { recursive: true, force: true });
        console.log("Global temporary directory and state files cleaned up.");
    }
}

main();
