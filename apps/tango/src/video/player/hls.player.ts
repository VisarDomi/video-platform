import { Emitter } from "../../core/emitter";
import { Events } from "../../core/events";
import { EventPayloads, IPlayerStrategy } from "../../types";

declare class Hls {
    constructor(config?: any);
    static Events: {
        MANIFEST_PARSED: string;
        ERROR: string;
    };
    loadSource(url: string): void;
    attachMedia(video: HTMLVideoElement): void;
    on(event: string, callback: (...args: any[]) => void): void;
    destroy(): void;
}

export class HlsPlayer implements IPlayerStrategy {
    private hls: Hls;
    private videoElement: HTMLVideoElement;
    private emitter: Emitter<EventPayloads>;
    private streamerName: string;
    private streamerId: string;

    constructor(videoElement: HTMLVideoElement, emitter: Emitter<EventPayloads>, streamerName: string, streamerId: string) {
        this.videoElement = videoElement;
        this.emitter = emitter;
        this.streamerName = streamerName;
        this.streamerId = streamerId;
        this.hls = new Hls({
            xhrSetup: (xhr: XMLHttpRequest) => {
                xhr.withCredentials = true;
            },
        });
        this.hls.attachMedia(this.videoElement);
    }

    public loadSource(url: string): void {
        this.hls.loadSource(url);

        this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
            this.emitter.emit(Events.DEBUG.LOG, {
                message: `${this.streamerName} -> Live: OK`,
                type: 'success'
            });
            this.videoElement.play().catch((e) => console.error("Autoplay failed", e));
        });

        this.hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
            if (data.fatal) {
                this.emitter.emit(Events.DEBUG.LOG, {
                    message: `${this.streamerName} -> Live: ERROR (${data.type})`,
                    type: 'error'
                });

                if (data.type === 'networkError') {
                    this.emitter.emit(Events.APP.REMOVE_STREAMER, this.streamerId);
                }
            }
        });
    }

    public destroy(): void {
        this.hls.destroy();
    }
}