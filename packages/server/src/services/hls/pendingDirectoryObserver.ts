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

        // Watch each handoff mailbox DIRECTLY and non-recursively: one kernel
        // watch per root, constant forever. The mailboxes are permanent
        // infrastructure (created eagerly at startup), so the watch never
        // dies and no recursive tree-watch is needed. A handoff is a folder
        // rename INTO the mailbox: a direct child event on the mailbox.
        for (const rootPath of this.rootPaths) {
            const resolved = path.resolve(rootPath);
            try {
                const watcher = watchDirectory(resolved, (_eventType, fileName) => {
                    const name = fileName?.toString();
                    if (!name) {
                        void this.reconcile();
                        return;
                    }
                    if (name.includes(path.sep)) return;
                    this.onCandidate(path.join(resolved, name));
                });
                watcher.on("error", (error) => {
                    this.onWatchError(resolved, error);
                    void this.reconcile();
                });
                this.watchers.push(watcher);
            } catch (error: any) {
                this.onWatchError(resolved, error);
            }
        }

        await this.reconcile();
    }

    public close(): void {
        for (const watcher of this.watchers.splice(0)) watcher.close();
    }
}
