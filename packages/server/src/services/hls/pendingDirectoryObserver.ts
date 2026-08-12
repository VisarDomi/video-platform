import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

export interface PendingDirectoryObserverDependencies {
    readonly watchDirectory?: (
        rootPath: string,
        listener: (eventType: string, fileName: string | Buffer | null) => void,
    ) => FSWatcher;
}

export class PendingDirectoryObserver {
    private readonly watchers: FSWatcher[] = [];

    constructor(
        private readonly rootPaths: readonly string[],
        private readonly onCandidate: (recordingPath: string) => void,
        private readonly reconcile: () => void | Promise<void>,
        private readonly onWatchError: (rootPath: string, error: Error) => void,
        private readonly dependencies: PendingDirectoryObserverDependencies = {},
    ) {}

    public async start(): Promise<void> {
        const watchDirectory = this.dependencies.watchDirectory
            ?? ((rootPath, listener) => watch(rootPath, listener));

        for (const rootPath of this.rootPaths) {
            try {
                const watcher = watchDirectory(rootPath, (_eventType, fileName) => {
                    const name = fileName?.toString();
                    if (!name) {
                        void this.reconcile();
                        return;
                    }
                    if (name.startsWith(".")) return;
                    this.onCandidate(path.join(rootPath, name));
                });
                watcher.on("error", (error) => {
                    this.onWatchError(rootPath, error);
                    void this.reconcile();
                });
                this.watchers.push(watcher);
            } catch (error: any) {
                this.onWatchError(rootPath, error);
            }
        }

        await this.reconcile();
    }

    public close(): void {
        for (const watcher of this.watchers.splice(0)) watcher.close();
    }
}
