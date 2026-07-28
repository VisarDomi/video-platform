import { EventPayloads, IApplicationState, Streamer, ViewMode } from "../types";
import { Emitter } from "./emitter";
import { Events } from "./events";


export class AppState {
    private readonly _streamers: Streamer[];
    private _currentIndex: number = 0;
    private _viewMode: ViewMode = 'list';
    private _scrollAnchorY: number = 0;
    private _scrollTarget: { streamerId: string; anchorY: number } | null = null;
    private emitter: Emitter<EventPayloads>;

    constructor(initialStreamers: Streamer[], emitter: Emitter<EventPayloads>) {
        this._streamers = initialStreamers;
        this.emitter = emitter;
    }

    public getState(): IApplicationState {
        return {
            streamers: this._streamers.map(s => ({ ...s })),
            currentIndex: this._currentIndex,
            currentStreamer: this.getCurrentStreamer(),
            previousStreamer: this.getPreviousStreamer(),
            nextStreamer: this.getNextStreamer(),
            viewMode: this._viewMode,
            scrollTarget: this._scrollTarget,
        };
    }

    public getCurrentStreamer(): Streamer {
        return { ...this._streamers[this._currentIndex] };
    }

    public getNextStreamer(): Streamer | undefined {
        if (this._currentIndex + 1 < this._streamers.length) {
            return { ...this._streamers[this._currentIndex + 1] };
        }
        return undefined;
    }

    public getPreviousStreamer(): Streamer | undefined {
        if (this._currentIndex - 1 >= 0) {
            return { ...this._streamers[this._currentIndex - 1] };
        }
        return undefined;
    }

    public appendStreamers(newStreamers: Streamer[]): void {
        const uniqueNewStreamers = newStreamers.filter((newStreamer) => !this._streamers.some((existing) => existing.streamerId === newStreamer.streamerId));

        if (uniqueNewStreamers.length > 0) {
            this._streamers.push(...uniqueNewStreamers);
            this.emitStateChange();
        }
    }

    public insertStreamersAfterCurrent(newStreamers: Streamer[]): void {
        if (newStreamers.length === 0) {
            return;
        }

        const uniqueNewStreamers = newStreamers.filter((newStreamer) => !this._streamers.some((existing) => existing.streamerId === newStreamer.streamerId));

        if (uniqueNewStreamers.length === 0) {
            return;
        }

        this._streamers.splice(this._currentIndex + 1, 0, ...uniqueNewStreamers);
        this.emitStateChange();
    }

    public removeStreamer(streamerId: string): void {
        const indexToRemove = this._streamers.findIndex(s => s.streamerId === streamerId);

        if (indexToRemove === -1) {
            return;
        }

        this._streamers.splice(indexToRemove, 1);

        if (this._streamers.length === 0) {
            this._currentIndex = 0;
        } else if (indexToRemove < this._currentIndex) {
            this._currentIndex--;
        } else if (indexToRemove === this._currentIndex) {
            if (this._currentIndex >= this._streamers.length) {
                this._currentIndex = this._streamers.length - 1;
            }
        }

        this.emitStateChange();
    }

    public next(): void {
        if (this._currentIndex < this._streamers.length - 1) {
            this._currentIndex++;
            this.emitStateChange();
        }
    }

    public previous(): void {
        if (this._currentIndex > 0) {
            this._currentIndex--;
            this.emitStateChange();
        }
    }

    public updateFollowingStatus(streamerId: string, isFollowing: boolean): void {
        const index = this._streamers.findIndex((s) => s.streamerId === streamerId);
        if (index !== -1) {
            this._streamers[index] = { ...this._streamers[index], isFollowing };
            this.emitStateChange();
        }
    }

    public captureScrollAnchor(anchorY: number) {
        this._scrollAnchorY = anchorY;
    }

    public updateScrollTarget(streamerId: string) {
        this._scrollTarget = { streamerId, anchorY: this._scrollAnchorY };
    }

    public setViewMode(mode: ViewMode): void {
        if (mode === 'list') {
            this._scrollTarget = null;
            this._scrollAnchorY = 0;
        }
        this._viewMode = mode;
        this.emitStateChange();
    }

    public playStreamer(streamerId: string): void {
        const index = this._streamers.findIndex(s => s.streamerId === streamerId);
        if (index !== -1) {
            this._currentIndex = index;
            this._viewMode = 'video';
            this.emitStateChange();
        }
    }

    private emitStateChange(): void {
        this.emitter.emit(Events.APP.STATE_CHANGED, this.getState());
    }
}