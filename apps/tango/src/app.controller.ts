import { Emitter } from "./core/emitter";
import { Events } from "./core/events";
import { ActionService } from "./services/api/action.service";
import { AppState } from "./core/app.state";
import { EventPayloads, Streamer } from "./types";
import { StreamLoaderService } from "./services/stream-loader.service";

interface AppControllerDependencies {
    actionService: ActionService;
    streamLoaderService: StreamLoaderService;
    emitter: Emitter<EventPayloads>;
    appState: AppState;
}

export class AppController {
    private actionService: ActionService;
    private streamLoaderService: StreamLoaderService;
    private emitter: Emitter<EventPayloads>;
    private store: AppState;

    constructor(dependencies: AppControllerDependencies) {
        this.actionService = dependencies.actionService;
        this.streamLoaderService = dependencies.streamLoaderService;
        this.emitter = dependencies.emitter;
        this.store = dependencies.appState;
    }

    public registerListeners() {
        this.emitter.on(Events.APP.LOAD_MORE_STREAMERS, this.loadMoreStreamers);
        this.emitter.on(Events.APP.REMOVE_STREAMER, this.removeStreamer);
        this.emitter.on(Events.UI.FOLLOW, this.follow);
        this.emitter.on(Events.UI.UNFOLLOW, this.unfollow);
        this.emitter.on(Events.UI.BLOCK, this.block);
        this.emitter.on(Events.UI.NEXT, this.next);
        this.emitter.on(Events.UI.PREVIOUS, this.previous);
        this.emitter.on(Events.UI.SHOW_LIST, this.showList);
        this.emitter.on(Events.UI.PLAY_STREAMER, this.playStreamer);
        this.emitter.on(Events.APP.INSERT_STREAMERS_AFTER_CURRENT, this.insertStreamersAfterCurrent);
    }

    public initialPrefetch() {
        // FORCE UPDATE = TRUE
        // This ensures that on app start, we fetch fresh aliases/names for the initial list,
        // refreshing the cache even if data exists.
        this.streamLoaderService.prefetchAliases(this.store.getState().streamers, true);
    }

    private loadMoreStreamers = async () => {
        await this.streamLoaderService.loadMoreStreamers();
    };

    private removeStreamer = (streamerId: string) => {
        this.store.removeStreamer(streamerId);
    }

    private follow = async () => {
        const streamer = this.store.getCurrentStreamer();
        if (!streamer) return;
        const originalStatus = streamer.isFollowing;

        this.store.updateFollowingStatus(streamer.streamerId, true);

        try {
            await this.actionService.follow(streamer.streamerId);
        } catch (error) {
            console.error("Failed to follow streamer:", error);
            this.store.updateFollowingStatus(streamer.streamerId, originalStatus);
        }
    };

    private unfollow = async () => {
        const streamer = this.store.getCurrentStreamer();
        if (!streamer) return;
        const originalStatus = streamer.isFollowing;

        this.store.updateFollowingStatus(streamer.streamerId, false);

        try {
            await this.actionService.unfollow(streamer.streamerId);
        } catch (error) {
            console.error("Failed to unfollow streamer:", error);
            this.store.updateFollowingStatus(streamer.streamerId, originalStatus);
        }
    };

    private block = async () => {
        const streamer = this.store.getCurrentStreamer();
        if (!streamer) return;

        if (streamer.isFollowing) {
            await this.unfollow();
        }

        try {
            const response = await this.actionService.block(streamer.streamerId);
            if (response.ok) {
                this.removeStreamer(streamer.streamerId);
            }
        } catch (error) {
            console.error("Failed to block streamer:", error);
        }
    };

    private next = () => {
        this.store.next();
        const current = this.store.getCurrentStreamer();
        if (current) this.store.updateScrollTarget(current.streamerId);
    };

    private previous = () => {
        this.store.previous();
        const current = this.store.getCurrentStreamer();
        if (current) this.store.updateScrollTarget(current.streamerId);
    };

    private showList = () => {
        this.store.setViewMode('list');
    };

    private playStreamer = (streamerId: string) => {
        this.store.playStreamer(streamerId);
    };

    private insertStreamersAfterCurrent = (streamers: Streamer[]) => {
        this.store.insertStreamersAfterCurrent(streamers);
    };
}