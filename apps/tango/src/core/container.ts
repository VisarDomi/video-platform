import { Emitter } from "./emitter";
import { UIManager } from "../ui/ui.manager";
import { ListManager } from "../ui/list/list.manager";
import { VideoManager } from "../video/video.manager";
import { AppController } from "../app.controller";
import { LiveUrlService } from "../video/live-url.service";
import { AliasService } from "../services/alias.service";
import { EventPayloads, Streamer } from "../types";
import { AuthService } from "../services/api/auth.service";
import { StreamerService } from "../services/api/streamer.service";
import { ActionService } from "../services/api/action.service";
import { AppState } from "./app.state";
import { createLiveUrlCache, ILiveUrlCache } from "../video/live-url-cache";
import { createAliasCache, IAliasCache } from "../services/alias-cache";
import { ServiceKeys } from "./service.keys";
import { DebugManager } from "../ui/debug/debug.manager";
import { StreamLoaderService } from "../services/stream-loader.service";
import { DownloadListService } from "../services/api/download-list.service";

interface AppDependencies {
    originalSetTimeout: typeof window.setTimeout;
    originalAddEventListener: typeof EventTarget.prototype.addEventListener;
    defaultInit: RequestInit;
    streamers: Streamer[];
}

export class ServiceContainer {
    private services = new Map<string, any>();
    private factories = new Map<string, (container: this) => any>();

    public register<T>(name: string, factory: (container: this) => T): void {
        this.factories.set(name, factory);
    }

    public resolve<T>(name: string): T {
        if (this.services.has(name)) {
            return this.services.get(name) as T;
        }

        const factory = this.factories.get(name);
        if (!factory) {
            throw new Error(`Service not registered: ${name}`);
        }

        const instance = factory(this);
        this.services.set(name, instance);
        return instance as T;
    }

    public static create(deps: AppDependencies) {
        const container = new ServiceContainer();

        container.register(ServiceKeys.EMITTER, () => new Emitter<EventPayloads>());
        container.register(ServiceKeys.LIVE_URL_CACHE, () => createLiveUrlCache(deps.originalSetTimeout));
        container.register(ServiceKeys.ALIAS_CACHE, () => createAliasCache(deps.originalSetTimeout));
        container.register(ServiceKeys.APP_STATE, (c) => new AppState(deps.streamers, c.resolve(ServiceKeys.EMITTER)));

        container.register(ServiceKeys.AUTH_SERVICE, () => new AuthService(deps.defaultInit));
        container.register(ServiceKeys.STREAMER_SERVICE, () => new StreamerService(deps.defaultInit));
        container.register(ServiceKeys.ACTION_SERVICE, () => new ActionService(deps.defaultInit));

        container.register(ServiceKeys.DOWNLOAD_LIST_SERVICE, () => new DownloadListService());

        container.register(ServiceKeys.LIVE_URL_SERVICE, (c) => new LiveUrlService(
            deps.defaultInit,
            c.resolve(ServiceKeys.LIVE_URL_CACHE),
            c.resolve(ServiceKeys.EMITTER)
        ));
        container.register(ServiceKeys.ALIAS_SERVICE, (c) => new AliasService(c.resolve(ServiceKeys.STREAMER_SERVICE), c.resolve(ServiceKeys.ALIAS_CACHE)));

        // Updated registration to inject Emitter
        container.register(ServiceKeys.STREAM_LOADER_SERVICE, (c) => new StreamLoaderService(
            c.resolve(ServiceKeys.STREAMER_SERVICE),
            c.resolve(ServiceKeys.ALIAS_SERVICE),
            c.resolve(ServiceKeys.APP_STATE),
            c.resolve(ServiceKeys.EMITTER)
        ));

        container.register(ServiceKeys.UI_MANAGER, (c) => new UIManager(c.resolve(ServiceKeys.EMITTER)));

        container.register(ServiceKeys.DEBUG_MANAGER, (c) => new DebugManager(c.resolve(ServiceKeys.EMITTER)));

        container.register(
            ServiceKeys.LIST_MANAGER,
            (c) => new ListManager(
                c.resolve(ServiceKeys.EMITTER),
                c.resolve(ServiceKeys.ALIAS_SERVICE)
            )
        );

        container.register(
            ServiceKeys.VIDEO_MANAGER,
            (c) =>
                new VideoManager({
                    videosContainer: c.resolve<UIManager>(ServiceKeys.UI_MANAGER).videosContainer,
                    gestureElements: {
                        videoView: c.resolve<UIManager>(ServiceKeys.UI_MANAGER).videoViewElement,
                        listView: c.resolve<UIManager>(ServiceKeys.UI_MANAGER).listViewElement,
                    },
                    emitter: c.resolve(ServiceKeys.EMITTER),
                    liveUrlService: c.resolve(ServiceKeys.LIVE_URL_SERVICE),
                    streamerService: c.resolve(ServiceKeys.STREAMER_SERVICE),
                    authService: c.resolve(ServiceKeys.AUTH_SERVICE),
                    aliasService: c.resolve(ServiceKeys.ALIAS_SERVICE),
                    downloadListService: c.resolve(ServiceKeys.DOWNLOAD_LIST_SERVICE),
                    originalSetTimeout: deps.originalSetTimeout,
                    originalAddEventListener: deps.originalAddEventListener,
                })
        );

        container.register(
            ServiceKeys.APP_CONTROLLER,
            (c) =>
                new AppController({
                    actionService: c.resolve(ServiceKeys.ACTION_SERVICE),
                    downloadListService: c.resolve(ServiceKeys.DOWNLOAD_LIST_SERVICE),
                    streamLoaderService: c.resolve(ServiceKeys.STREAM_LOADER_SERVICE),
                    aliasService: c.resolve(ServiceKeys.ALIAS_SERVICE),
                    emitter: c.resolve(ServiceKeys.EMITTER),
                    appState: c.resolve(ServiceKeys.APP_STATE),
                })
        );

        // Migrate old unified cache to new split caches
        migrateOldCache();

        // Clear caches on startup
        container.resolve<ILiveUrlCache>(ServiceKeys.LIVE_URL_CACHE).clear();
        container.resolve<IAliasCache>(ServiceKeys.ALIAS_CACHE).clear();

        return container;
    }
}

function migrateOldCache() {
    const OLD_KEY = "tango_script_cache";
    try {
        const stored = localStorage.getItem(OLD_KEY);
        if (!stored) return;

        const parsed = JSON.parse(stored);

        if (parsed.liveUrls && Object.keys(parsed.liveUrls).length > 0) {
            localStorage.setItem("tango_liveurl_cache", JSON.stringify(parsed.liveUrls));
        }

        if ((parsed.aliases && Object.keys(parsed.aliases).length > 0) || (parsed.names && Object.keys(parsed.names).length > 0)) {
            localStorage.setItem("tango_alias_cache", JSON.stringify({
                aliases: parsed.aliases || {},
                names: parsed.names || {},
            }));
        }

        localStorage.removeItem(OLD_KEY);
    } catch (e) {
        console.error("Cache migration failed", e);
        localStorage.removeItem(OLD_KEY);
    }
}
