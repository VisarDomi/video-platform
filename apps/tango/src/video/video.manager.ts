import { Emitter } from "../core/emitter";
import { Events } from "../core/events";
import { EventPayloads, IApplicationState, Streamer } from "../types";
import { LiveUrlService } from "./live-url.service";
import { StreamerService } from "../services/api/streamer.service";
import { AliasService } from "../services/alias.service";
import { DownloadListService } from "../services/api/download-list.service";
import { StreamUnit } from "../ui/stream-unit/stream-unit";
import { GestureElements, PeekCallbacks } from "../ui/gesture/gesture-controller";

interface VideoManagerDependencies {
    videosContainer: HTMLDivElement;
    gestureElements: GestureElements;
    emitter: Emitter<EventPayloads>;
    liveUrlService: LiveUrlService;
    streamerService: StreamerService;
    aliasService: AliasService;
    downloadListService: DownloadListService;
    originalSetTimeout: typeof window.setTimeout;
    originalAddEventListener: typeof EventTarget.prototype.addEventListener;
}

export class VideoManager {
    private previousIndex: number = 0;
    private processedForMulti: Set<string> = new Set();
    private lastStreamerId: string | null = null;
    private units: StreamUnit[] = [];
    private activeUnit: StreamUnit | null = null;
    private uiVisible: boolean = true;
    private stateGeneration: number = 0;
    private readonly NAV_COMMIT_THRESHOLD = 0.2;
    private readonly NAV_ANIM_MS = 250;

    constructor(private readonly deps: VideoManagerDependencies) {}

    private get videosContainer() { return this.deps.videosContainer; }
    private get emitter() { return this.deps.emitter; }
    private get liveUrlService() { return this.deps.liveUrlService; }
    private get streamerService() { return this.deps.streamerService; }
    private get aliasService() { return this.deps.aliasService; }
    private get downloadListService() { return this.deps.downloadListService; }
    private get gestureElements() { return this.deps.gestureElements; }
    private get originalSetTimeout() { return this.deps.originalSetTimeout; }
    private get originalAddEventListener() { return this.deps.originalAddEventListener; }

    public registerListeners() {
        this.emitter.on(Events.APP.STATE_CHANGED, this.onStateChanged);
        this.emitter.on(Events.UI.TOGGLE_MUTE, this.onToggleMute);
        this.emitter.on(Events.UI.SET_UI_VISIBLE, this.onSetUiVisible);
    }

    public async initialize(state: IApplicationState) {
        const [prev, curr, next] = [this._createUnit(), this._createUnit(), this._createUnit()];
        this.units = [prev, curr, next];
        this.videosContainer.append(prev.element, curr.element, next.element);

        this.previousIndex = state.currentIndex;
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

        void this._primeLiveUrlCache(state.streamers);
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
        const gen = ++this.stateGeneration;
        const owns = () => this.stateGeneration === gen;

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
        this.previousIndex = newIndex;

        if (newIndex === oldIndex) {
            if (state.viewMode === 'video') {
                this.activeUnit?.update(state.currentStreamer);
                await Promise.all([
                    this.units[0].update(state.previousStreamer),
                    this.units[2].update(state.nextStreamer)
                ]);
                if (!owns()) return;
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

        if (!owns()) return;

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
        const streamersCopy = streamers.map(s => ({ ...s }));

        for (const streamer of streamersCopy) {
            await this.liveUrlService.fetchAndParseLiveUrl(streamer);
            await new Promise<void>((resolve) => this.originalSetTimeout(resolve, 500));
        }
    }


    public navPeekUpdate(dy: number): void {
        const vh = window.innerHeight;
        const active = this.units[1];
        const peekUnit = dy < 0 ? this.units[2] : this.units[0];
        const hideUnit = dy < 0 ? this.units[0] : this.units[2];

        hideUnit.element.hidden = true;
        peekUnit.element.hidden = false;

        active.element.style.transition = 'none';
        peekUnit.element.style.transition = 'none';

        active.element.style.transform = `translateY(${dy}px)`;
        if (dy < 0) {
            peekUnit.element.style.transform = `translateY(${dy + vh}px)`;
        } else {
            peekUnit.element.style.transform = `translateY(${dy - vh}px)`;
        }
    }

    public navPeekRelease(dy: number, onDone: () => void): void {
        const vh = window.innerHeight;
        const active = this.units[1];
        const peekUnit = dy < 0 ? this.units[2] : this.units[0];
        const commit = Math.abs(dy) > vh * this.NAV_COMMIT_THRESHOLD && peekUnit.hasContent;

        const transition = `transform ${this.NAV_ANIM_MS}ms ease-out`;
        active.element.style.transition = transition;
        peekUnit.element.style.transition = transition;

        if (commit) {
            active.element.style.transform = dy < 0 ? `translateY(${-vh}px)` : `translateY(${vh}px)`;
            peekUnit.element.style.transform = 'translateY(0)';

            const onEnd = () => {
                active.element.removeEventListener('transitionend', onEnd);
                this._clearPeekStyles();
                if (dy < 0) {
                    this.emitter.emit(Events.UI.NEXT);
                } else {
                    this.emitter.emit(Events.UI.PREVIOUS);
                }
                onDone();
            };
            active.element.addEventListener('transitionend', onEnd, { once: true });
        } else {
            active.element.style.transform = 'translateY(0)';
            if (dy < 0) {
                peekUnit.element.style.transform = `translateY(${vh}px)`;
            } else {
                peekUnit.element.style.transform = `translateY(${-vh}px)`;
            }

            const onEnd = () => {
                active.element.removeEventListener('transitionend', onEnd);
                this._clearPeekStyles();
                onDone();
            };
            active.element.addEventListener('transitionend', onEnd, { once: true });
        }
    }

    public navPeekCancel(): void {
        this._clearPeekStyles();
    }

    private _clearPeekStyles(): void {
        for (let i = 0; i < this.units.length; i++) {
            const el = this.units[i].element;
            el.style.transform = '';
            el.style.transition = '';
            if (i !== 1) {
                el.hidden = true;
            }
        }
    }

    private _createUnit(): StreamUnit {
        const peekCallbacks: PeekCallbacks = {
            navPeekUpdate: (dy) => this.navPeekUpdate(dy),
            navPeekRelease: (dy, onDone) => this.navPeekRelease(dy, onDone),
            navPeekCancel: () => this.navPeekCancel(),
        };
        const unit = new StreamUnit(this.emitter, this.aliasService, this.liveUrlService, this.downloadListService, this.gestureElements, this.originalAddEventListener, peekCallbacks);
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
