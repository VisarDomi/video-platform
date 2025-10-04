// src/frontend/modules/player.ts
import { DomElements, Video } from "../types";
import { Store } from "./store";

export const STORAGE_KEY_PREFIX = "video-progress-";

export class Player {
    private dom: DomElements;
    private store: Store;

    constructor(domElements: DomElements, store: Store) {
        this.dom = domElements;
        this.store = store;
    }

    public playVideo(video: Video, startTime = 0): void {
        if (!video) {
            this.stopPlayback();
            return;
        }

        this.dom.videoPlayer.controls = false;
        this.dom.videoPlayer.loop = false;
        this.dom.videoPlayer.src = `/video/${video.type}/${encodeURIComponent(video.filename)}`;

        const seekOnLoad = () => {
            if (startTime > 0 && startTime < this.dom.videoPlayer.duration) {
                this.dom.videoPlayer.currentTime = startTime;
            }
            this.dom.videoPlayer.removeEventListener("loadedmetadata", seekOnLoad);
        };
        this.dom.videoPlayer.addEventListener("loadedmetadata", seekOnLoad);

        this.dom.videoPlayer.play().catch((e) => console.error("Autoplay failed:", e));
    }

    public stopPlayback(): void {
        this.dom.videoPlayer.pause();
        this.dom.videoPlayer.removeAttribute("src");
        this.dom.videoPlayer.load();
    }

    public navigateToVideo(video: Video): void {
        const savedTime = localStorage.getItem(STORAGE_KEY_PREFIX + video.filename);
        const startTime = savedTime && parseFloat(savedTime) > 0 ? Math.round(parseFloat(savedTime)) : 0;
        this.store.playVideo(video, startTime);
    }

    public navigateVideoInList(direction: 1 | -1): void {
        const { videoList, filter, currentVideo, lastPlayedVideo } = this.store.getState();
        const regex = filter ? new RegExp(filter, "i") : null;
        const filteredList = videoList.filter((video) => !regex || regex.test(video.filename));

        const activeVideo = currentVideo || lastPlayedVideo;
        if (!activeVideo) return;

        const currentIndex = filteredList.findIndex((v) => v.filename === activeVideo.filename && v.type === activeVideo.type);

        const nextIndex = currentIndex + direction;
        if (nextIndex >= 0 && nextIndex < filteredList.length) {
            this.navigateToVideo(filteredList[nextIndex]);
        }
    }
}
