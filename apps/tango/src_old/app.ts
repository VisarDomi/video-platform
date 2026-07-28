import { Emitter } from "./core/emitter";
import { EventPayloads } from "./types";
import { AppState } from "./core/app.state";
import { AuthService } from "./services/api/auth.service";
import { StreamerService } from "./services/api/streamer.service";
import { ActionService } from "./services/api/action.service";
import { DownloadListService } from "./services/api/download-list.service";
import { LiveUrlService } from "./video/live-url.service";
import { AliasService } from "./services/alias.service";
import { StreamLoaderService } from "./services/stream-loader.service";
import { UIManager } from "./ui/ui.manager";
import { ListManager } from "./ui/list/list.manager";
import { VideoManager } from "./video/video.manager";
import { AppController } from "./app.controller";
import { createLiveUrlCache } from "./video/live-url-cache";
import { createAliasCache } from "./services/alias-cache";
import { preparePageEnvironment, startDOMSanitizer } from "./core/environment";
import { CONSTANTS } from "./core/constants";
import { UI_STYLES } from "./ui/ui.resources";

export class Application {
    public async start() {
        const { setInterval, setTimeout, addEventListener } = preparePageEnvironment();
        startDOMSanitizer(setInterval);

        await new AuthService().ensureTokens();
        const streamers = await new StreamerService().fetchStreamers();

        if (streamers.length === 0) {
            alert("[tango] No streamers found. Refreshing page...");
            return;
        }

        await this._loadHls();

        const emitter = new Emitter<EventPayloads>();
        const appState = new AppState(streamers, emitter);
        const liveUrlCache = createLiveUrlCache();
        const aliasCache = createAliasCache();
        const streamerService = new StreamerService();
        const authService = new AuthService();
        const actionService = new ActionService();
        const downloadListService = new DownloadListService();
        const liveUrlService = new LiveUrlService(liveUrlCache);
        const aliasService = new AliasService(streamerService, aliasCache);
        const streamLoaderService = new StreamLoaderService(streamerService, aliasService, appState, emitter);
        const uiManager = new UIManager(emitter);
        const listManager = new ListManager(emitter, aliasService);
        const videoManager = new VideoManager({
            videosContainer: uiManager.videosContainer,
            gestureElements: { videoView: uiManager.videoViewElement, listView: uiManager.listViewElement },
            emitter, liveUrlService, streamerService, aliasService, downloadListService,
            originalSetTimeout: setTimeout,
            originalAddEventListener: addEventListener,
        });
        const appController = new AppController({ actionService, downloadListService, streamLoaderService, emitter, appState });

        liveUrlCache.clear();
        aliasCache.clear();

        this._injectStyles();
        authService.startTokenRefresh(setInterval);
        void downloadListService.fetchList();
        appController.registerListeners();
        videoManager.registerListeners();
        uiManager.registerListeners();
        listManager.registerListeners();
        listManager.initialize(appState.getState());
        appController.initialPrefetch();
        streamLoaderService.startAutoLoading(setInterval);
        await videoManager.initialize(appState.getState());
    }

    private async _loadHls(): Promise<void> {
        const script = document.createElement("script");
        script.id = CONSTANTS.DOM.HLS_SCRIPT_ID;
        script.src = "https://cdn.jsdelivr.net/npm/hls.js@latest";
        document.body.appendChild(script);
        await new Promise<void>((resolve) => (script.onload = () => resolve()));
    }

    private _injectStyles(): void {
        const style = document.createElement("style");
        style.id = CONSTANTS.DOM.STYLE_ELEMENT_ID;
        style.textContent = UI_STYLES;
        document.head.appendChild(style);
    }
}
