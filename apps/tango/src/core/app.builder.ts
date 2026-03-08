import { ServiceContainer } from "./container";
import { preparePageEnvironment, startDOMSanitizer } from "./environment";
import { StreamerService } from "../services/api/streamer.service";
import { Streamer } from "../types";
import { AppController } from "../app.controller";
import { VideoManager } from "../video/video.manager";
import { UIManager } from "../ui/ui.manager";
import { ListManager } from "../ui/list/list.manager";
import { AuthService } from "../services/api/auth.service";
import { ServiceKeys } from "./service.keys";
import { CONSTANTS } from "./constants";
import { UI_STYLES } from "../ui/ui.resources";
import { DebugManager } from "../ui/debug/debug.manager";
import { DownloadListService } from "../services/api/download-list.service";

interface BuiltApplication {
    run: () => Promise<void>;
}

export class ApplicationBuilder {
    private originalSetInterval!: typeof window.setInterval;
    private originalSetTimeout!: typeof window.setTimeout;
    private originalAddEventListener!: typeof EventTarget.prototype.addEventListener;
    private defaultInit!: RequestInit;
    private streamers!: Streamer[];

    public withEnvironment(): this {
        const { setInterval, setTimeout, addEventListener } = preparePageEnvironment();
        this.originalSetInterval = setInterval;
        this.originalSetTimeout = setTimeout;
        this.originalAddEventListener = addEventListener;
        startDOMSanitizer(this.originalSetInterval);
        return this;
    }

    public withApiConfig(init: RequestInit): this {
        this.defaultInit = init;
        return this;
    }

    public async withInitialData(): Promise<this> {
        if (!this.defaultInit) {
            throw new Error("API config must be set before fetching initial data.");
        }
        const streamerService = new StreamerService(this.defaultInit);
        this.streamers = await streamerService.fetchStreamers(CONSTANTS.APP.FETCH_BATCH_SIZE);
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
            console.log("No streamers found or API failed. Stopping script.");
            return { run: async () => {} };
        }

        const container = ServiceContainer.create({
            originalSetTimeout: this.originalSetTimeout,
            originalAddEventListener: this.originalAddEventListener,
            defaultInit: this.defaultInit,
            streamers: this.streamers,
        });

        const authService = container.resolve<AuthService>(ServiceKeys.AUTH_SERVICE);
        const appController = container.resolve<AppController>(ServiceKeys.APP_CONTROLLER);
        const downloadListService = container.resolve<DownloadListService>(ServiceKeys.DOWNLOAD_LIST_SERVICE);
        const videoManager = container.resolve<VideoManager>(ServiceKeys.VIDEO_MANAGER);
        const uiManager = container.resolve<UIManager>(ServiceKeys.UI_MANAGER);
        const listManager = container.resolve<ListManager>(ServiceKeys.LIST_MANAGER);

        const run = async () => {
            this.injectStyles();
            authService.startTokenRefresh(this.originalSetInterval);
            downloadListService.fetchList();
            appController.registerListeners();
            videoManager.registerListeners();
            uiManager.registerListeners();
            listManager.registerListeners();

            if (CONSTANTS.DEBUG.ENABLED) {
                const debugManager = container.resolve<DebugManager>(ServiceKeys.DEBUG_MANAGER);
                debugManager.registerListeners();
            }

            // Initialize List View content
            listManager.initialize();

            appController.initialPrefetch();

            await videoManager.initialize();
        };

        return { run };
    }
}