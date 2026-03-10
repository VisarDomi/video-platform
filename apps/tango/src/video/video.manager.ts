import { Emitter } from "../core/emitter";
import { Events } from "../core/events";
import { EventPayloads, IApplicationState, Streamer } from "../types";
import { LiveUrlService } from "./live-url.service";
import { StreamerService } from "../services/api/streamer.service";
import { AuthService } from "../services/api/auth.service";
import { AliasService } from "../services/alias.service";
import { DownloadListService } from "../services/api/download-list.service";
import { StreamUnit } from "../ui/stream-unit/stream-unit";
import { GestureElements } from "../ui/gesture/gesture-controller";

interface VideoManagerDependencies {
    initialState: IApplicationState;
    videosContainer: HTMLDivElement;
    gestureElements: GestureElements;
    emitter: Emitter<EventPayloads>;
    liveUrlService: LiveUrlService;
    streamerService: StreamerService;
    aliasService: AliasService;
    downloadListService: DownloadListService;
    authService: AuthService;
    originalSetTimeout: typeof window.setTimeout;
    originalAddEventListener: typeof EventTarget.prototype.addEventListener;
}

export class VideoManager {
    private videosContainer: HTMLDivElement;
    private emitter: Emitter<EventPayloads>;
    private liveUrlService: LiveUrlService;
    private streamerService: StreamerService;
    private authService: AuthService;
    private aliasService: AliasService;
    private downloadListService: DownloadListService;
    private gestureElements: GestureElements;
    private originalSetTimeout: typeof window.setTimeout;
    private originalAddEventListener: typeof EventTarget.prototype.addEventListener;
    private previousIndex: number;
    private processedForMulti: Set<string> = new Set();
    private lastStreamerId: string | null = null;
    private initialState: IApplicationState;

    private units: StreamUnit[] = [];
    private activeUnit: StreamUnit | null = null;
    private uiVisible: boolean = true;

    // Reconnection / freeze recovery
    private readonly RESUME_THRESHOLD_MS = 3000;
    private backgroundedAt = 0;
    private isVisible = true;

    constructor(dependencies: VideoManagerDependencies) {
        this.initialState = dependencies.initialState;
        this.videosContainer = dependencies.videosContainer;
        this.gestureElements = dependencies.gestureElements;
        this.emitter = dependencies.emitter;
        this.liveUrlService = dependencies.liveUrlService;
        this.streamerService = dependencies.streamerService;
        this.authService = dependencies.authService;
        this.aliasService = dependencies.aliasService;
        this.downloadListService = dependencies.downloadListService;
        this.originalSetTimeout = dependencies.originalSetTimeout;
        this.originalAddEventListener = dependencies.originalAddEventListener;
        this.previousIndex = this.initialState.currentIndex;
    }

    public registerListeners() {
        this.emitter.on(Events.APP.STATE_CHANGED, this.onStateChanged);
        this.emitter.on(Events.UI.TOGGLE_MUTE, this.onToggleMute);
        this.emitter.on(Events.UI.SET_UI_VISIBLE, this.onSetUiVisible);
        this._setupConnectionMonitor();
    }

    // --- Reconnection / freeze recovery ---

    private _setupConnectionMonitor() {
        const listen = this.originalAddEventListener;

        listen.call(window, 'online', () => {
            console.log('[VideoManager] Back online → resuming');
            this._resumeActiveUnit();
        });

        listen.call(document, 'visibilitychange', () => {
            const visible = document.visibilityState === 'visible';
            this.isVisible = visible;
            this._handleVisibilityChange(visible);
        });

        // iOS PWA fallbacks
        listen.call(window, 'pageshow', () => {
            if (document.visibilityState === 'visible' && !this.isVisible) {
                this.isVisible = true;
                this._handleVisibilityChange(true);
            }
        });

        listen.call(window, 'focus', () => {
            if (!this.isVisible) {
                this.isVisible = true;
                this._handleVisibilityChange(true);
            }
        });
    }

    private _handleVisibilityChange(visible: boolean) {
        if (!visible) {
            this.backgroundedAt = Date.now();
        } else {
            const elapsed = this.backgroundedAt > 0 ? Date.now() - this.backgroundedAt : 0;
            this.backgroundedAt = 0;
            if (elapsed > this.RESUME_THRESHOLD_MS) {
                console.log(`[VideoManager] Resuming after ${Math.round(elapsed / 1000)}s`);
                this._resumeActiveUnit();
            }
        }
    }

    private async _resumeActiveUnit() {
        await this.authService.ensureTokens();
        if (this.activeUnit) {
            this.activeUnit.resume();
        }
    }

    public async initialize() {
        const [prev, curr, next] = [this._createUnit(), this._createUnit(), this._createUnit()];
        this.units = [prev, curr, next];
        this.videosContainer.append(prev.element, curr.element, next.element);

        const state = this.initialState;
        this.lastStreamerId = state.currentStreamer?.streamerId || null;

        await Promise.all([
            prev.update(state.previousStreamer),
            curr.update(state.currentStreamer),
            next.update(state.nextStreamer),
        ]);

        curr.setHidden(false);
        this.activeUnit = curr;
        this.activeUnit.setMuted(true);

        for (const unit of this.units) {
            unit.setUiVisible(this.uiVisible);
        }

        this.emitter.emit(Events.APP.STATE_CHANGED, state);

        await this._checkForMultiBroadcast(state.currentStreamer);

        this._primeLiveUrlCache(state.streamers);
    }

    private onToggleMute = () => {
        if (this.activeUnit) {
            this.activeUnit.setMuted(!this.activeUnit.isMuted);
        }
    };

    private onSetUiVisible = (visible: boolean) => {
        this.uiVisible = visible;
        for (const unit of this.units) {
            unit.setUiVisible(visible);
        }
    };

    private onStateChanged = async (state: IApplicationState) => {
        const currentStreamer = state.currentStreamer;
        const currentId = currentStreamer?.streamerId;

        if (currentId && this.lastStreamerId === currentId) {
            this.previousIndex = state.currentIndex;
            await Promise.all([
                this.units[0].update(state.previousStreamer),
                this.units[1].update(currentStreamer),
                this.units[2].update(state.nextStreamer)
            ]);
            return;
        }

        this.lastStreamerId = currentId || null;

        const newIndex = state.currentIndex;
        const oldIndex = this.previousIndex;

        if (newIndex === oldIndex) {
            // Identity changed, but index is same (e.g. Remove Streamer)
            // Need to update active unit AND neighbors because the array shifted
            if (state.viewMode === 'video') {
                this.activeUnit?.update(state.currentStreamer);
                await Promise.all([
                    this.units[0].update(state.previousStreamer),
                    this.units[2].update(state.nextStreamer)
                ]);
                await this._checkForMultiBroadcast(state.currentStreamer);
            }
            return;
        }

        const isNext = newIndex === oldIndex + 1;
        const isPrev = newIndex === oldIndex - 1;

        if (isNext) {
            await this._handleNextNavigation(state);
        } else if (isPrev) {
            await this._handlePreviousNavigation(state);
        } else {
            await this._handleJumpNavigation(state);
        }

        this.previousIndex = newIndex;

        if (this.activeUnit && state.viewMode === 'video') {
            this.activeUnit.play();
        }

        await this._checkForMultiBroadcast(state.currentStreamer);
    };

    private async _checkForMultiBroadcast(streamer: Streamer) {
        if (!streamer || this.processedForMulti.has(streamer.streamerId)) {
            return;
        }
        this.processedForMulti.add(streamer.streamerId);

        this.emitter.emit(Events.VIDEO.MULTI_BROADCAST_FETCH_START);

        const multiStreamers = await this.streamerService.fetchMultiBroadcastStreamers(streamer.streamId);

        let streamsAdded = false;
        if (multiStreamers.length > 1) {
            const otherStreamers = multiStreamers
                .filter((s) => s.streamerId !== streamer.streamerId)
                .map(s => ({
                    ...s,
                    parentStreamerId: streamer.streamerId
                }));

            if (otherStreamers.length > 0) {
                this.emitter.emit(Events.APP.INSERT_STREAMERS_AFTER_CURRENT, otherStreamers);
                streamsAdded = true;
            }
        }

        if (streamsAdded) {
            // The state change from insert will trigger onStateChanged which updates neighbors
            this.emitter.emit(Events.VIDEO.MULTI_BROADCAST_FETCH_END);
        } else {
            this.emitter.emit(Events.VIDEO.MULTI_BROADCAST_FETCH_END);
        }
    }

    private async _handleNextNavigation(state: IApplicationState) {
        const [curr, nextUnit, reused] = this._rotateUnitsForward();
        curr.setHidden(true);
        nextUnit.setHidden(false);
        reused.setHidden(true);
        this.activeUnit = nextUnit;

        curr.setMuted(true);
        nextUnit.setMuted(true);

        await reused.update(state.nextStreamer);
    }

    private async _handlePreviousNavigation(state: IApplicationState) {
        const [reused, prevUnit, curr] = this._rotateUnitsBackward();
        curr.setHidden(true);
        prevUnit.setHidden(false);
        reused.setHidden(true);
        this.activeUnit = prevUnit;

        curr.setMuted(true);
        prevUnit.setMuted(true);

        await reused.update(state.previousStreamer);
    }

    private async _handleJumpNavigation(state: IApplicationState) {
        const [prev, curr, next] = this.units;

        prev.setHidden(true);
        curr.setHidden(true);
        next.setHidden(true);

        await Promise.all([
            prev.update(state.previousStreamer),
            curr.update(state.currentStreamer),
            next.update(state.nextStreamer),
        ]);

        curr.setHidden(false);
        this.activeUnit = curr;
        this.activeUnit.setMuted(true);
    }

    private async _primeLiveUrlCache(streamers: Streamer[]) {
        console.log("Starting background cache priming...");
        const streamersCopy = [...streamers];

        for (const streamer of streamersCopy) {
            const displayName = await this.aliasService.getAliasFor(streamer.streamerId);
            await this.liveUrlService.fetchAndParseLiveUrl(streamer, displayName);
            await new Promise<void>((resolve) => this.originalSetTimeout(resolve, 500));
        }
        console.log("Background cache priming finished.");
    }

    private _createUnit(): StreamUnit {
        const unit = new StreamUnit(this.emitter, this.aliasService, this.liveUrlService, this.downloadListService, this.gestureElements, this.originalAddEventListener);
        unit.setHidden(true);
        return unit;
    }

    private _rotateUnitsForward(): [StreamUnit, StreamUnit, StreamUnit] {
        const [p, c, n] = this.units;
        this.videosContainer.removeChild(p.element);
        this.videosContainer.appendChild(p.element);
        this.units = [c, n, p];
        return [c, n, p];
    }

    private _rotateUnitsBackward(): [StreamUnit, StreamUnit, StreamUnit] {
        const [p, c, n] = this.units;
        this.videosContainer.removeChild(n.element);
        this.videosContainer.insertBefore(n.element, p.element);
        this.units = [n, p, c];
        return [n, p, c];
    }
}
