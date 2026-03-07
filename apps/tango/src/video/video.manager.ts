import { Emitter } from "../core/emitter";
import { Events } from "../core/events";
import { EventPayloads, IApplicationState, Streamer } from "../types";
import { LiveUrlService } from "./live-url.service";
import { StreamerService } from "../services/api/streamer.service";
import { AppState } from "../core/app.state";
import { AliasService } from "../services/alias.service";
import { StreamUnit } from "../ui/stream-unit/stream-unit";
import { GestureElements } from "../ui/gesture/gesture-controller";

interface VideoManagerDependencies {
    appState: AppState;
    videosContainer: HTMLDivElement;
    gestureElements: GestureElements;
    emitter: Emitter<EventPayloads>;
    liveUrlService: LiveUrlService;
    streamerService: StreamerService;
    aliasService: AliasService;
    originalSetTimeout: typeof window.setTimeout;
    originalAddEventListener: typeof EventTarget.prototype.addEventListener;
}

export class VideoManager {
    private store: AppState;
    private videosContainer: HTMLDivElement;
    private emitter: Emitter<EventPayloads>;
    private liveUrlService: LiveUrlService;
    private streamerService: StreamerService;
    private aliasService: AliasService;
    private originalSetTimeout: typeof window.setTimeout;
    private gestureElements: GestureElements;
    private originalAddEventListener: typeof EventTarget.prototype.addEventListener;
    private previousIndex: number;
    private processedForMulti: Set<string> = new Set();
    private lastStreamerId: string | null = null;

    private units: StreamUnit[] = [];
    private activeUnit: StreamUnit | null = null;
    private uiVisible: boolean = true;

    constructor(dependencies: VideoManagerDependencies) {
        this.store = dependencies.appState;
        this.videosContainer = dependencies.videosContainer;
        this.gestureElements = dependencies.gestureElements;
        this.emitter = dependencies.emitter;
        this.liveUrlService = dependencies.liveUrlService;
        this.streamerService = dependencies.streamerService;
        this.aliasService = dependencies.aliasService;
        this.originalSetTimeout = dependencies.originalSetTimeout;
        this.originalAddEventListener = dependencies.originalAddEventListener;
        this.previousIndex = this.store.getState().currentIndex;
    }

    public registerListeners() {
        this.emitter.on(Events.APP.STATE_CHANGED, this.onStateChanged);
        this.emitter.on(Events.UI.TOGGLE_MUTE, this.onToggleMute);
        this.emitter.on(Events.UI.SET_UI_VISIBLE, this.onSetUiVisible);
    }

    public async initialize() {
        const [prev, curr, next] = [this._createUnit(), this._createUnit(), this._createUnit()];
        this.units = [prev, curr, next];
        this.videosContainer.append(prev.element, curr.element, next.element);

        const currentStreamer = this.store.getCurrentStreamer();
        this.lastStreamerId = currentStreamer?.streamerId || null;

        await Promise.all([
            prev.update(this.store.getPreviousStreamer()),
            curr.update(currentStreamer),
            next.update(this.store.getNextStreamer()),
        ]);

        curr.setHidden(false);
        this.activeUnit = curr;
        this.activeUnit.setMuted(true);

        for (const unit of this.units) {
            unit.setUiVisible(this.uiVisible);
        }

        this.emitter.emit(Events.APP.STATE_CHANGED, this.store.getState());

        await this._checkForMultiBroadcast(this.store.getCurrentStreamer());

        this._primeLiveUrlCache();
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
                this.units[0].update(this.store.getPreviousStreamer()),
                this.units[1].update(currentStreamer),
                this.units[2].update(this.store.getNextStreamer())
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
                    this.units[0].update(this.store.getPreviousStreamer()),
                    this.units[2].update(this.store.getNextStreamer())
                ]);
                await this._checkForMultiBroadcast(state.currentStreamer);
            }
            return;
        }

        const isNext = newIndex === oldIndex + 1;
        const isPrev = newIndex === oldIndex - 1;

        if (isNext) {
            await this._handleNextNavigation();
        } else if (isPrev) {
            await this._handlePreviousNavigation();
        } else {
            await this._handleJumpNavigation();
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
                this.store.insertStreamersAfterCurrent(otherStreamers);
                streamsAdded = true;
            }
        }

        if (streamsAdded) {
            const nextUnit = this.units[2];
            await nextUnit.update(this.store.getNextStreamer());
        }

        if (this.store.getNextStreamer()) {
            this.emitter.emit(Events.VIDEO.MULTI_BROADCAST_FETCH_END);
        }
    }

    private async _handleNextNavigation() {
        const [curr, nextUnit, reused] = this._rotateUnitsForward();
        curr.setHidden(true);
        nextUnit.setHidden(false);
        reused.setHidden(true);
        this.activeUnit = nextUnit;

        curr.setMuted(true);
        nextUnit.setMuted(true);

        await reused.update(this.store.getNextStreamer());
    }

    private async _handlePreviousNavigation() {
        const [reused, prevUnit, curr] = this._rotateUnitsBackward();
        curr.setHidden(true);
        prevUnit.setHidden(false);
        reused.setHidden(true);
        this.activeUnit = prevUnit;

        curr.setMuted(true);
        prevUnit.setMuted(true);

        await reused.update(this.store.getPreviousStreamer());
    }

    private async _handleJumpNavigation() {
        const [prev, curr, next] = this.units;

        prev.setHidden(true);
        curr.setHidden(true);
        next.setHidden(true);

        await Promise.all([
            prev.update(this.store.getPreviousStreamer()),
            curr.update(this.store.getCurrentStreamer()),
            next.update(this.store.getNextStreamer()),
        ]);

        curr.setHidden(false);
        this.activeUnit = curr;
        this.activeUnit.setMuted(true);
    }

    private async _primeLiveUrlCache() {
        console.log("Starting background cache priming...");
        const { streamers } = this.store.getState();
        const streamersCopy = [...streamers];

        for (const streamer of streamersCopy) {
            const displayName = await this.aliasService.getAliasFor(streamer);
            await this.liveUrlService.fetchAndParseLiveUrl(streamer, displayName);
            await new Promise<void>((resolve) => this.originalSetTimeout(resolve, 500));
        }
        console.log("Background cache priming finished.");
    }

    private _createUnit(): StreamUnit {
        const unit = new StreamUnit(this.emitter, this.aliasService, this.liveUrlService, this.gestureElements, this.originalAddEventListener);
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