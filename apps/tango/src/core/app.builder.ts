import { ServiceContainer } from "./container";
import { preparePageEnvironment, startDOMSanitizer } from "./environment";
import { AuthService } from "../services/api/auth.service";
import { StreamerService } from "../services/api/streamer.service";
import { Streamer } from "../types";
import { AppController } from "../app.controller";
import { VideoManager } from "../video/video.manager";
import { UIManager } from "../ui/ui.manager";
import { ListManager } from "../ui/list/list.manager";
import { AppState } from "./app.state";
import { ServiceKeys } from "./service.keys";
import { CONSTANTS } from "./constants";
import { UI_STYLES } from "../ui/ui.resources";
import { DownloadListService } from "../services/api/download-list.service";
import { StreamLoaderService } from "../services/stream-loader.service";

interface BuiltApplication {
    run: () => Promise<void>;
}

export class ApplicationBuilder {
    private originalSetInterval!: typeof window.setInterval;
    private originalSetTimeout!: typeof window.setTimeout;
    private originalAddEventListener!: typeof EventTarget.prototype.addEventListener;
    private streamers!: Streamer[];

    public withEnvironment(): this {
        const { setInterval, setTimeout, addEventListener } = preparePageEnvironment();
        this.originalSetInterval = setInterval;
        this.originalSetTimeout = setTimeout;
        this.originalAddEventListener = addEventListener;
        startDOMSanitizer(this.originalSetInterval);
        return this;
    }

    public async withInitialData(): Promise<this> {
        const authService = new AuthService();
        await authService.ensureTokens();

        const streamerService = new StreamerService();
        this.streamers = await streamerService.fetchStreamers();
        return this;
    }

    public async withExternalScripts(): Promise<this> {
        const script = document.createElement("script");
        script.id = CONSTANTS.DOM.HLS_SCRIPT_ID;
        script.src = "https://cdn.jsdelivr.net/npm/hls.js@latest";
        document.body.appendChild(script);
        await new Promise<void>((resolve) => (script.onload = () => resolve()));
        return this;
    }

    private injectStyles(): void {
        const style = document.createElement("style");
        style.id = CONSTANTS.DOM.STYLE_ELEMENT_ID;
        style.textContent = UI_STYLES;
        document.head.appendChild(style);
    }

    public build(): BuiltApplication {
        if (this.streamers.length === 0) {
            alert("[tango] No streamers found or API failed. Refreshing page...");
            return { run: async () => {} };
        }

        const container = ServiceContainer.create({
            originalSetTimeout: this.originalSetTimeout,
            originalAddEventListener: this.originalAddEventListener,
            streamers: this.streamers,
        });

        const authService = container.resolve<AuthService>(ServiceKeys.AUTH_SERVICE);
        const appController = container.resolve<AppController>(ServiceKeys.APP_CONTROLLER);
        const streamLoaderService = container.resolve<StreamLoaderService>(ServiceKeys.STREAM_LOADER_SERVICE);
        const downloadListService = container.resolve<DownloadListService>(ServiceKeys.DOWNLOAD_LIST_SERVICE);
        const videoManager = container.resolve<VideoManager>(ServiceKeys.VIDEO_MANAGER);
        const uiManager = container.resolve<UIManager>(ServiceKeys.UI_MANAGER);
        const listManager = container.resolve<ListManager>(ServiceKeys.LIST_MANAGER);

        const run = async () => {
            this.injectStyles();
            authService.startTokenRefresh(this.originalSetInterval);
            void downloadListService.fetchList();
            appController.registerListeners();
            videoManager.registerListeners();
            uiManager.registerListeners();
            listManager.registerListeners();

            const appState = container.resolve<AppState>(ServiceKeys.APP_STATE);
            listManager.initialize(appState.getState());

            appController.initialPrefetch();
            streamLoaderService.startAutoLoading(this.originalSetInterval);

            await videoManager.initialize(appState.getState());
        };

        return { run };
    }
}