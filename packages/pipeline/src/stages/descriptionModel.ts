import { LlamaServer } from "descriptor";

// The description model kept loaded in the worker: the description lane describes one
// recording after another without loading the model each time (about 30 s and the disk
// reads of a 10 GB model). Descriptions and the upload's phrase rewrite share it one request
// at a time (the server has one slot). Outside the worker (manual commands) none is kept,
// and each call loads and unloads its own.
export class KeptDescriptionModel {
    readonly server = new LlamaServer();
    private queue: Promise<unknown> = Promise.resolve();

    get loaded(): boolean { return this.server.running; }

    // Runs one request against the kept server, after the requests before it.
    use<T>(request: (server: LlamaServer) => Promise<T>): Promise<T> {
        const turn = this.queue.then(() => request(this.server));
        this.queue = turn.catch(() => undefined);
        return turn;
    }

    // Frees the GPU and the memory (a manual pause, the worker stopping), after the
    // request in flight.
    async unload(): Promise<void> {
        await this.use(async () => { if (this.server.running) await this.server.stop(); });
    }
}

let kept: KeptDescriptionModel | null = null;

// The worker keeps the model loaded for its lifetime; everything else loads it per call.
export function keepDescriptionModelLoaded(): KeptDescriptionModel {
    kept ??= new KeptDescriptionModel();
    return kept;
}

export function keptDescriptionModel(): KeptDescriptionModel | null {
    return kept;
}
