import path from "path";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import pLimit from "p-limit";
import * as utils from "./utils.js";
import logger from "./logger.js";

let daemonProcess: ChildProcess | null = null;
let currentResolve: ((value: Record<string, number>) => void) | null = null;
let currentPaths: string[] = []; // Store paths to map response back to filenames
const daemonLock = pLimit(1);

function getDaemon(): ChildProcess {
    if (daemonProcess && !daemonProcess.killed) {
        return daemonProcess;
    }

    const projectRoot = utils.findProjectRoot();
    const binaryPath = path.join(projectRoot, "src", "core", "bin", "playlist-parser");

    daemonProcess = spawn(binaryPath);

    const rl = createInterface({ input: daemonProcess.stdout! });
    rl.on('line', (line) => {
        if (currentResolve) {
            try {
                // Protocol: Semicolon separated values "10.5;0;20.1"
                // Order matches currentPaths exactly
                const durations = line.split(';');
                const result: Record<string, number> = {};

                // Map values back to paths
                for (let i = 0; i < currentPaths.length; i++) {
                    const duration = parseFloat(durations[i]);
                    // Safety check for parsing errors
                    result[currentPaths[i]] = isNaN(duration) ? 0 : duration;
                }

                const resolve = currentResolve;
                currentResolve = null;
                currentPaths = [];
                resolve(result);
            } catch (err) {
                logger.error("Failed to parse Go output line", { err });
                if (currentResolve) {
                    currentResolve({});
                    currentResolve = null;
                    currentPaths = [];
                }
            }
        }
    });

    daemonProcess.stderr?.on('data', (data) => {
        logger.error(`Go Parser Stderr: ${data}`);
    });

    daemonProcess.on('exit', (code) => {
        logger.warn(`Go Parser exited with code ${code}`);
        daemonProcess = null;
        if (currentResolve) {
            currentResolve({});
            currentResolve = null;
            currentPaths = [];
        }
    });

    return daemonProcess;
}

export function getDurationsFromGo(filePaths: string[]): Promise<Record<string, number>> {
    return daemonLock(() => {
        return new Promise<Record<string, number>>((resolve) => {
            try {
                const process = getDaemon();
                currentResolve = resolve;
                currentPaths = filePaths;

                if (filePaths.length === 0) {
                    resolve({});
                    return;
                }

                process.stdin?.write(filePaths.join('\n') + '\n<<BATCH_END>>\n');
            } catch (error) {
                logger.error("Failed to communicate with Go daemon", { error });
                resolve({});
            }
        });
    });
}