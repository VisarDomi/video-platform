// tests/lifecycle.e2e.ts
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import * as url from "url";
// Correctly import from the compiled output
import * as configLoader from "../dist/common/config.js";
import { findProjectRoot } from "../dist/common/utils.js";

// --- Test Constants & Configuration ---
const TEST_TIMEOUT = 5 * 60 * 1000;
const DOWNLOAD_DURATION_S = 60;
const MONITORING_INTERVAL_MS = 5000;

// --- Correct Path Resolution (as you provided) ---
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = findProjectRoot(__dirname);
const config = configLoader.getConfig();
const configPath = path.join(projectRoot, "config.json");

// --- Helper Functions ---

const log = (phase: string, message: string) => {
    console.log(`[Phase ${phase} Test Runner] ${message}`);
};

const runCommand = (command: string, args: string[]): Promise<string> => {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args);
        let stdout = "", stderr = "";
        process.stdout.on("data", (data) => (stdout += data.toString()));
        process.stderr.on("data", (data) => (stderr += data.toString()));
        process.on("close", (code) => {
            if (code === 0) resolve(stdout.trim());
            else reject(new Error(`Command "${command} ${args.join(" ")}" failed with code ${code}:\n${stderr}`));
        });
        process.on("error", (err) => reject(err));
    });
};

const startApp = (): ChildProcess => {
    log("N/A", "Starting application process...");
    // Use your specified command to run from dist
    const appProcess = spawn("node", [path.join(projectRoot, "dist/main.js")], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: projectRoot,
    });
    appProcess.stdout?.on("data", (data) => process.stdout.write(`[APP] ${data.toString()}`));
    appProcess.stderr?.on("data", (data) => process.stderr.write(`[APP ERROR] ${data.toString()}`));
    return appProcess;
};

const stopApp = async (appProcess: ChildProcess | null): Promise<void> => {
    if (!appProcess || appProcess.killed) return;
    log("N/A", "Gracefully stopping application process...");
    appProcess.kill("SIGINT");
    await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            if (!appProcess.killed) appProcess.kill("SIGKILL");
            resolve(null);
        }, 5000);
        appProcess.on("exit", () => {
            clearTimeout(timeout);
            resolve(null);
        });
    });
    log("N/A", "Application process stopped.");
};

const waitFor = async (conditionFn: () => Promise<boolean>, timeoutMs: number, intervalMs: number, description: string): Promise<void> => {
    const startTime = Date.now();
    log("N/A", `Waiting for condition: ${description}`);
    while (Date.now() - startTime < timeoutMs) {
        if (await conditionFn()) {
            log("N/A", `Condition met: ${description}`);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timeout waiting for condition: ${description}`);
};

const cleanup = async () => {
    log("N/A", "--- Running Cleanup ---");
    const cleanupPromises = [
        fs.rm(config.storagePath, { recursive: true, force: true }).catch(() => {}),
        fs.unlink(path.join(projectRoot, config.fileNames.liveStatus)).catch(() => {}),
        fs.unlink(path.join(projectRoot, "processed-by-combiner.txt")).catch(() => {}),
    ];
    await Promise.all(cleanupPromises);
    log("N/A", "Cleanup complete.");
};

const reportDownloadHealth = (duration: number, segmentCount: number) => {
    const green = "\x1b[32m", yellow = "\x1b[33m", red = "\x1b[31m", reset = "\x1b[0m";
    log("1: Downloader", "--- Download Health Report ---");
    log("1: Downloader", `Final Segment Count: ${segmentCount}`);
    log("1: Downloader", `Video Duration (ffprobe): ${duration.toFixed(2)} seconds`);
    if (duration >= DOWNLOAD_DURATION_S * 0.9) {
        log("1: Downloader", `${green}Verdict: HEALTHY - Download was stable and complete.${reset}`);
    } else if (duration >= DOWNLOAD_DURATION_S * 0.5) {
        log("1: Downloader", `${yellow}Verdict: DEGRADED - Download was successful but may have stalled.${reset}`);
    } else {
        log("1: Downloader", `${red}Verdict: UNHEALTHY - Download failed to capture sufficient data.${reset}`);
        throw new Error(`Download was unhealthy. Duration: ${duration.toFixed(2)}s, Segments: ${segmentCount}.`);
    }
};

// --- Main Test Logic ---
async function runE2ETest() {
    let appProcess: ChildProcess | null = null;
    let streamerFolderName: string | null = null;
    let mp4FileName: string | null = null;
    let originalConfig: string | null = null;

    try {
        // --- Global Setup ---
        originalConfig = await fs.readFile(configPath, "utf-8");
        const baseConfig = configLoader.getConfig(); // Load the FULLY MERGED config
        log("0: Setup", `Using storage path: ${baseConfig.storagePath}`);
        await cleanup();
        await fs.mkdir(baseConfig.storagePath, { recursive: true });
        await fs.access(path.join(projectRoot, "session.json"));

        // --- PHASE 1: Downloader ---
        console.log("\n--- PHASE 1: Testing Downloader ---");
        // Use original config for this phase
        appProcess = startApp();
        // ... (rest of downloader test is unchanged) ...
        await waitFor(async () => {
            const files = await fs.readdir(baseConfig.storagePath, { withFileTypes: true }).catch(() => []);
            const folder = files.find((f) => f.isDirectory() && f.name.match(/^\d{4}-\d{2}-\d{2} \d{6} .+/));
            if (folder) streamerFolderName = folder.name;
            return !!folder;
        }, 60000, 2000, "streamer download folder to be created");
        if (!streamerFolderName) throw new Error("Streamer folder was not created.");
        log("1: Downloader", `Detected streamer folder: ${streamerFolderName}`);
        const tsFilePath = path.join(baseConfig.storagePath, `${streamerFolderName}.ts`);
        const segmentsFolderPath = path.join(baseConfig.storagePath, streamerFolderName);
        log("1: Downloader", `Monitoring download for ${DOWNLOAD_DURATION_S} seconds...`);
        await new Promise(resolve => setTimeout(resolve, DOWNLOAD_DURATION_S * 1000));
        log("1: Downloader", "Monitoring complete. Stopping app to analyze results.");
        await stopApp(appProcess);
        appProcess = null;
        const finalSegmentCount = (await fs.readdir(segmentsFolderPath)).filter((f) => f.endsWith(".ts")).length;
        const duration = parseFloat(await runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", tsFilePath,]));
        reportDownloadHealth(duration, finalSegmentCount);
        log("1: Downloader", "SUCCESS - Download health check passed.");


        // --- PHASE 2: Assembler (Downloader Disabled) ---
        console.log("\n--- PHASE 2: Testing Assembler ---");
        const assemblerConfig = configLoader.getConfig(); // Get a fresh, merged config object
        assemblerConfig.downloader.enabled = false; // This is now safe
        await fs.writeFile(configPath, JSON.stringify(assemblerConfig, null, 4));
        log("2: Assembler", "Config updated to disable downloader. Deleting live-status.json.");
        await fs.unlink(path.join(projectRoot, baseConfig.fileNames.liveStatus)).catch(() => {});
        appProcess = startApp();
        mp4FileName = `${streamerFolderName}.mp4`;
        const mp4FilePath = path.join(baseConfig.storagePath, mp4FileName);
        // ... (rest of assembler test is unchanged) ...
        await waitFor(async () => fs.access(mp4FilePath).then(() => true).catch(() => false), 120000, 2000, "MP4 file to be created");
        log("2: Assembler", `MP4 file created: ${mp4FileName}. Verifying cleanup...`);
        await waitFor(async () => fs.access(segmentsFolderPath).then(() => false).catch(() => true), 30000, 1000, "raw segment folder to be deleted");
        await waitFor(async () => fs.access(tsFilePath).then(() => false).catch(() => true), 30000, 1000, "large .ts file to be deleted");
        log("2: Assembler", "SUCCESS - MP4 assembled and raw files cleaned up.");
        await stopApp(appProcess);
        appProcess = null;

        // --- PHASE 3: Combiner (Downloader & Assembler Disabled) ---
        console.log("\n--- PHASE 3: Testing Combiner ---");
        const combinerConfig = configLoader.getConfig(); // Get a fresh, merged config object
        combinerConfig.downloader.enabled = false;
        combinerConfig.repackager.enabled = false; // This is now safe
        await fs.writeFile(configPath, JSON.stringify(combinerConfig, null, 4));
        // ... (rest of combiner test is unchanged) ...
        log("3: Combiner", "Config updated to disable downloader and assembler.");
        const editedFolderPath = path.join(baseConfig.storagePath, "edited");
        await fs.mkdir(editedFolderPath, { recursive: true });
        const mp4Duration = parseFloat(await runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", mp4FilePath,]));
        const minCombineDuration = baseConfig.combiner.minDurationMinutes * 60;
        const copiesNeeded = Math.ceil(minCombineDuration / mp4Duration) + 1;
        log("3: Combiner", `MP4 duration is ${mp4Duration.toFixed(1)}s. Creating ${copiesNeeded} copies to exceed ${minCombineDuration}s.`);
        const parsedName = mp4FileName.match(/^(\d{4}-\d{2}-\d{2} \d{4})(\d{2}) (.+)\.mp4$/);
        if (!parsedName) throw new Error("Could not parse MP4 filename to setup combiner test.");
        const [, date, seconds, username] = parsedName;
        for (let i = 0; i < copiesNeeded; i++) {
            const newSeconds = String(parseInt(seconds) + i).padStart(2, "0");
            const newFileName = `${date}${newSeconds} ${username}.mp4`;
            await fs.copyFile(mp4FilePath, path.join(editedFolderPath, newFileName));
        }
        appProcess = startApp();
        await waitFor(async () => (await fs.readdir(editedFolderPath)).some(f => f.includes("min.mp4")), 120000, 2000, "combined MP4 file to be created");
        log("3: Combiner", "SUCCESS - Videos combined as expected.");
        await stopApp(appProcess);
        appProcess = null;


        console.log("\n✅✅✅ E2E LIFECYCLE TEST PASSED ✅✅✅\n");
    } catch (error) {
        console.error("\n❌❌❌ E2E LIFECYCLE TEST FAILED ❌❌❌");
        console.error(error);
        process.exitCode = 1;
    } finally {
        if (appProcess && !appProcess.killed) await stopApp(appProcess);
        if (originalConfig) await fs.writeFile(configPath, originalConfig); // Restore config
        await cleanup();
    }
}

// --- Execute ---
(async () => {
    // Set a hard timeout for the entire test suite
    const timeout = setTimeout(() => {
        console.error(`\n❌❌❌ E2E TEST SUITE TIMED OUT AFTER ${TEST_TIMEOUT / 1000}s ❌❌❌`);
        process.exit(1);
    }, TEST_TIMEOUT);

    await runE2ETest();

    clearTimeout(timeout);
    process.exit(process.exitCode || 0);
})();