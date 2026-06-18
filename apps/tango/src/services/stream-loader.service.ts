import { AppState } from "../core/app.state";
import { AliasService } from "./alias.service";
import { StreamerService } from "./api/streamer.service";
import { Streamer, EventPayloads } from "../types";
import { Emitter } from "../core/emitter";
import { Events } from "../core/events";

export class StreamLoaderService {
    private streamerService: StreamerService;
    private aliasService: AliasService;
    private appState: AppState;
    private emitter: Emitter<EventPayloads>;
    private prefetching: Set<string> = new Set();
    private isFetching: boolean = false;

    constructor(
        streamerService: StreamerService,
        aliasService: AliasService,
        appState: AppState,
        emitter: Emitter<EventPayloads>
    ) {
        this.streamerService = streamerService;
        this.aliasService = aliasService;
        this.appState = appState;
        this.emitter = emitter;
    }

    public startAutoLoading(setInterval: typeof window.setInterval): void {
        setInterval(() => this.loadMoreStreamers(), 10_000);
    }

    public async loadMoreStreamers(): Promise<void> {
        if (this.isFetching) return;

        this.isFetching = true;
        try {
            const newStreamers = await this.streamerService.fetchStreamers();

            this.appState.appendStreamers(newStreamers);

            if (newStreamers.length > 0) {
                this._prefetchAliasesFor(newStreamers, false);
            }
        } finally {
            this.isFetching = false;
        }
    }

    public prefetchAliases(streamers: Streamer[], forceUpdate: boolean = false): void {
        this._prefetchAliasesFor(streamers, forceUpdate);
    }

    private _prefetchAliasesFor(streamersToProcess: Streamer[], forceUpdate: boolean): void {
        // We filter out IDs that are currently being fetched to avoid network duplication
        const streamersToPrefetch: Streamer[] = streamersToProcess.filter((streamer) => !this.prefetching.has(streamer.streamerId));

        if (streamersToPrefetch.length > 0) {
            const streamerIdsBeingFetched = streamersToPrefetch.map((s) => s.streamerId);
            streamerIdsBeingFetched.forEach((id) => this.prefetching.add(id));

            this.aliasService.getAliasesFor(streamersToPrefetch.map(s => s.streamerId), forceUpdate).finally(() => {
                streamerIdsBeingFetched.forEach((id) => this.prefetching.delete(id));
                // Signal UI to re-read from cache/memory
                this.emitter.emit(Events.APP.UPDATE_UI, { streamerId: '' });
            });
        }
    }
}