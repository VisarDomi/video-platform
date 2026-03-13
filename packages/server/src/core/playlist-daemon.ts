import path from "path";
import { spawn, ChildProcess } from "child_process";
import { createInterface } from "readline";
import pLimit from "p-limit";
import * as utils from "./utils.js";
import logger from "./logger.js";

class PlaylistDaemon {
    private daemonProcess: ChildProcess | null = null;
    private currentResolve: ((value: Record<string, number>) => void) | null = null;
    private currentPaths: string[] = [];
    private daemonLock = pLimit(1);

    private getDaemon(): ChildProcess {
        if (this.daemonProcess && !this.daemonProcess.killed) {
            return this.daemonProcess;
        }

        const projectRoot = utils.findProjectRoot();
        const binaryPath = path.join(projectRoot, "src", "core", "bin", "playlist-parser");

        this.daemonProcess = spawn(binaryPath);

        const rl = createInterface({ input: this.daemonProcess.stdout! });
        rl.on('line', (line) => {
            if (this.currentResolve) {
                try {
                    const durations = line.split(';');
                    const result: Record<string, number> = {};

                    for (let i = 0; i < this.currentPaths.length; i++) {
                        const duration = parseFloat(durations[i]);
                        result[this.currentPaths[i]] = isNaN(duration) ? 0 : duration;
                    }

                    const resolve = this.currentResolve;
                    this.currentResolve = null;
                    this.currentPaths = [];
                    resolve(result);
                } catch (err) {
                    logger.error("Failed to parse Go output line", { err });
                    if (this.currentResolve) {
                        this.currentResolve({});
                        this.currentResolve = null;
                        this.currentPaths = [];
                    }
                }
            }
        });

        this.daemonProcess.stderr?.on('data', (data) => {
            logger.error(`Go Parser Stderr: ${data}`);
        });

        this.daemonProcess.on('exit', (code) => {
            logger.warn(`Go Parser exited with code ${code}`);
            this.daemonProcess = null;
            if (this.currentResolve) {
                this.currentResolve({});
                this.currentResolve = null;
                this.currentPaths = [];
            }
        });

        return this.daemonProcess;
    }

    getDurationsFromGo(filePaths: string[]): Promise<Record<string, number>> {
        return this.daemonLock(() => {
            return new Promise<Record<string, number>>((resolve) => {
                try {
                    const process = this.getDaemon();
                    this.currentResolve = resolve;
                    this.currentPaths = filePaths;

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
}

const playlistDaemon = new PlaylistDaemon();

export function getDurationsFromGo(filePaths: string[]): Promise<Record<string, number>> {
    return playlistDaemon.getDurationsFromGo(filePaths);
}
