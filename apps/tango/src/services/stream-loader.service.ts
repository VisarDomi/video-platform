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
        if (streamersToProcess.length > 0) {
            this.aliasService.getAliasesFor(streamersToProcess.map(s => s.streamerId), forceUpdate).then(() => {
                this.emitter.emit(Events.APP.UPDATE_UI, { streamerId: '' });
            });
        }
    }
}