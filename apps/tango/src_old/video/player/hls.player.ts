import { IPlayerStrategy } from "../../types";

declare class Hls {
    constructor(config?: any);
    static Events: {
        MANIFEST_PARSED: string;
        ERROR: string;
    };
    loadSource(url: string): void;
    startLoad(): void;
    recoverMediaError(): void;
    attachMedia(video: HTMLVideoElement): void;
    on(event: string, callback: (...args: any[]) => void): void;
    destroy(): void;
}

export interface HlsCallbacks {
    onReady: () => void;
    onFatalError: (type: 'network' | 'media') => void;
}

export class HlsPlayer implements IPlayerStrategy {
    private hls: Hls;
    private videoElement: HTMLVideoElement;
    private callbacks: HlsCallbacks;

    constructor(videoElement: HTMLVideoElement, callbacks: HlsCallbacks) {
        this.videoElement = videoElement;
        this.callbacks = callbacks;
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
            this.videoElement.play();
            this.callbacks.onReady();
        });

        this.hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
            if (data.fatal) {
                if (data.type === 'networkError') {
                    this.hls.startLoad();
                    this.callbacks.onFatalError('network');
                } else if (data.type === 'mediaError') {
                    this.hls.recoverMediaError();
                    this.callbacks.onFatalError('media');
                }
            }
        });
    }

    public resume(): void {
        this.hls.startLoad();
        this.videoElement.play();
    }

    public destroy(): void {
        this.hls.destroy();
    }
}
