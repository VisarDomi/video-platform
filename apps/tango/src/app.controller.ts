import { Emitter } from "./core/emitter";
import { Events } from "./core/events";
import { ActionService } from "./services/api/action.service";
import { DownloadListService } from "./services/api/download-list.service";
import { AppState } from "./core/app.state";
import { EventPayloads, Streamer } from "./types";
import { StreamLoaderService } from "./services/stream-loader.service";
interface AppControllerDependencies {
    actionService: ActionService;
    downloadListService: DownloadListService;
    streamLoaderService: StreamLoaderService;
    emitter: Emitter<EventPayloads>;
    appState: AppState;
}

export class AppController {
    private actionService: ActionService;
    private downloadListService: DownloadListService;
    private streamLoaderService: StreamLoaderService;
    private emitter: Emitter<EventPayloads>;
    private store: AppState;

    constructor(dependencies: AppControllerDependencies) {
        this.actionService = dependencies.actionService;
        this.downloadListService = dependencies.downloadListService;
        this.streamLoaderService = dependencies.streamLoaderService;
        this.emitter = dependencies.emitter;
        this.store = dependencies.appState;
    }

    public registerListeners() {
        this.emitter.on(Events.APP.REMOVE_STREAMER, this.removeStreamer);
        this.emitter.on(Events.UI.FOLLOW, this.follow);
        this.emitter.on(Events.UI.UNFOLLOW, this.unfollow);
        this.emitter.on(Events.UI.BLOCK, this.block);
        this.emitter.on(Events.UI.NEXT, this.next);
        this.emitter.on(Events.UI.PREVIOUS, this.previous);
        this.emitter.on(Events.UI.SHOW_LIST, this.showList);
        this.emitter.on(Events.UI.PLAY_STREAMER, this.playStreamer);
        this.emitter.on(Events.APP.INSERT_STREAMERS_AFTER_CURRENT, this.insertStreamersAfterCurrent);
        this.emitter.on(Events.UI.ADD_TO_DOWNLOAD_LIST, this.addToDownloadList);
        this.emitter.on(Events.UI.REMOVE_FROM_DOWNLOAD_LIST, this.removeFromDownloadList);
        this.emitter.on(Events.UI.CAPTURE_SCROLL_ANCHOR, this.captureScrollAnchor);
    }

    public initialPrefetch() {
        // FORCE UPDATE = TRUE
        // This ensures that on app start, we fetch fresh aliases/names for the initial list,
        // refreshing the cache even if data exists.
        this.streamLoaderService.prefetchAliases(this.store.getState().streamers, true);
    }

    private removeStreamer = (streamerId: string) => {
        this.store.removeStreamer(streamerId);
    }

    private follow = async () => {
        const streamer = this.store.getCurrentStreamer();
        if (!streamer) return;
        const { streamerId, isFollowing: originalStatus } = streamer;

        this.store.updateFollowingStatus(streamerId, true);

        try {
            await this.actionService.follow(streamerId);
        } catch (error) {
            console.error("Failed to follow streamer:", error);
            this.store.updateFollowingStatus(streamerId, originalStatus);
        }
    };

    private unfollow = async () => {
        const streamer = this.store.getCurrentStreamer();
        if (!streamer) return;
        const { streamerId, isFollowing: originalStatus } = streamer;

        this.store.updateFollowingStatus(streamerId, false);

        try {
            await this.actionService.unfollow(streamerId);
        } catch (error) {
            console.error("Failed to unfollow streamer:", error);
            this.store.updateFollowingStatus(streamerId, originalStatus);
        }
    };

    private block = async () => {
        const streamer = this.store.getCurrentStreamer();
        if (!streamer) return;
        const { streamerId, isFollowing } = streamer;

        try {
            if (isFollowing) {
                await this.actionService.unfollow(streamerId);
            }
            const response = await this.actionService.block(streamerId);
            if (response.ok) {
                this.store.removeStreamer(streamerId);
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

    private captureScrollAnchor = (anchorY: number) => {
        this.store.captureScrollAnchor(anchorY);
    };

    private insertStreamersAfterCurrent = (streamers: Streamer[]) => {
        this.store.insertStreamersAfterCurrent(streamers);
        this.streamLoaderService.prefetchAliases(streamers, false);
    };

    private addToDownloadList = async () => {
        const streamer = this.store.getCurrentStreamer();
        if (!streamer) return;
        await this.downloadListService.add(streamer.streamerId);
        this.emitter.emit(Events.APP.UPDATE_UI, { streamerId: streamer.streamerId });
    };

    private removeFromDownloadList = async () => {
        const streamer = this.store.getCurrentStreamer();
        if (!streamer) return;
        await this.downloadListService.remove(streamer.streamerId);
        this.emitter.emit(Events.APP.UPDATE_UI, { streamerId: streamer.streamerId });
    };
}
