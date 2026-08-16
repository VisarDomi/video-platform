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
            ?? ((rootPath, listener) => watch(rootPath, { recursive: true }, listener));

        // Watch the PARENT of each handoff root recursively: the hidden
        // handoff directory is created on demand and removed when empty, so
        // watching it directly would die with it. Events are filtered to the
        // handoff child and its direct recording entries.
        const parents = new Map<string, string>();
        for (const rootPath of this.rootPaths) {
            const resolved = path.resolve(rootPath);
            parents.set(path.dirname(resolved), path.basename(resolved));
        }
        for (const [parent, child] of parents) {
            try {
                const watcher = watchDirectory(parent, (_eventType, fileName) => {
                    const name = fileName?.toString();
                    if (!name) {
                        void this.reconcile();
                        return;
                    }
                    if (name !== child && !name.startsWith(child + path.sep)) return;
                    if (name === child) {
                        // The handoff directory itself appeared/disappeared.
                        void this.reconcile();
                        return;
                    }
                    const rest = name.slice(child.length + 1);
                    if (!rest || rest.includes(path.sep)) return;
                    this.onCandidate(path.join(parent, name));
                });
                watcher.on("error", (error) => {
                    this.onWatchError(parent, error);
                    void this.reconcile();
                });
                this.watchers.push(watcher);
            } catch (error: any) {
                this.onWatchError(parent, error);
            }
        }

        await this.reconcile();
    }

    public close(): void {
        for (const watcher of this.watchers.splice(0)) watcher.close();
    }
}
