import path from "path";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import pLimit from "p-limit";
import * as utils from "./utils.js";
import logger from "./logger.js";

let daemonProcess: ChildProcess | null = null;
let currentResolve: ((value: Record<string, number>) => void) | null = null;
const daemonLock = pLimit(1); // Serialize access to the daemon

function getDaemon(): ChildProcess {
    if (daemonProcess && !daemonProcess.killed) {
        return daemonProcess;
    }

    const projectRoot = utils.findProjectRoot();
    const binaryPath = path.join(projectRoot, "src", "core", "bin", "playlist-parser");

    daemonProcess = spawn(binaryPath);

    // Setup stdout listener
    const rl = createInterface({ input: daemonProcess.stdout! });
    rl.on('line', (line) => {
        if (currentResolve) {
            try {
                const result = JSON.parse(line);
                const resolve = currentResolve;
                currentResolve = null;
                resolve(result);
            } catch (err) {
                logger.error("Failed to parse Go output line", { err, line });
                // Don't leave the request hanging
                if (currentResolve) {
                    currentResolve({});
                    currentResolve = null;
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
        }
    });

    return daemonProcess;
}

export function getDurationsFromGo(filePaths: string[]): Promise<Record<string, number>> {
    // We wrap this in daemonLock to ensure we only send one batch at a time
    // and wait for its specific response.
    return daemonLock(() => {
        return new Promise<Record<string, number>>((resolve) => {
            try {
                const process = getDaemon();
                currentResolve = resolve;

                // Write paths followed by the sentinel
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