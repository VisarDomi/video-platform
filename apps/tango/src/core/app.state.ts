import { EventPayloads, IApplicationState, Streamer, ViewMode } from "../types";
import { Emitter } from "./emitter";
import { Events } from "./events";


export class AppState {
    private _streamers: Streamer[];
    private _currentIndex: number = 0;
    private _viewMode: ViewMode = 'list';
    private emitter: Emitter<EventPayloads>;

    constructor(initialStreamers: Streamer[], emitter: Emitter<EventPayloads>) {
        this._streamers = initialStreamers;
        this.emitter = emitter;
    }

    public getState(): IApplicationState {
        return {
            streamers: this._streamers,
            currentIndex: this._currentIndex,
            currentStreamer: this.getCurrentStreamer(),
            previousStreamer: this.getPreviousStreamer(),
            nextStreamer: this.getNextStreamer(),
            viewMode: this._viewMode,
        };
    }

    public getCurrentStreamer(): Streamer {
        return this._streamers[this._currentIndex];
    }

    public getNextStreamer(): Streamer | undefined {
        if (this._currentIndex + 1 < this._streamers.length) {
            return this._streamers[this._currentIndex + 1];
        }
        return undefined;
    }

    public getPreviousStreamer(): Streamer | undefined {
        if (this._currentIndex - 1 >= 0) {
            return this._streamers[this._currentIndex - 1];
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

            if (this._currentIndex >= this._streamers.length - 2) {
                this.emitter.emit(Events.APP.LOAD_MORE_STREAMERS);
            }
        }
    }

    public previous(): void {
        if (this._currentIndex > 0) {
            this._currentIndex--;
            this.emitStateChange();
        }
    }

    public updateFollowingStatus(streamerId: string, isFollowing: boolean): void {
        const streamer = this._streamers.find((s) => s.streamerId === streamerId);
        if (streamer) {
            streamer.isFollowing = isFollowing;
            this.emitStateChange();
        }
    }

    public setViewMode(mode: ViewMode): void {
        this._viewMode = mode;
        this.emitStateChange();
    }

    public setIndexToStreamer(streamerId: string): void {
        const index = this._streamers.findIndex(s => s.streamerId === streamerId);
        if (index !== -1) {
            this._currentIndex = index;
            this.emitStateChange();
        }
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