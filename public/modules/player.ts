// public/modules/player.ts
import { DomElements, Video } from "../types";
import { store } from "./store";

export const STORAGE_KEY_PREFIX = "video-progress-";
let dom: Partial<DomElements> = {};

export function initPlayer(elements: DomElements): void {
    dom = elements;
}

export function playVideo(video: Video, startTime = 0): void {
    if (!video || !dom.videoPlayer) {
        stopPlayback();
        return;
    }

    dom.videoPlayer.controls = false;
    dom.videoPlayer.loop = false;
    dom.videoPlayer.src = `/video/${video.type}/${encodeURIComponent(video.filename)}`;

    const seekOnLoad = () => {
        // FIX: Added a type guard to ensure dom.videoPlayer exists inside this closure.
        if (dom.videoPlayer) {
            if (startTime > 0 && startTime < dom.videoPlayer.duration) {
                dom.videoPlayer.currentTime = startTime;
            }
            dom.videoPlayer.removeEventListener("loadedmetadata", seekOnLoad);
        }
    };
    dom.videoPlayer.addEventListener("loadedmetadata", seekOnLoad);

    dom.videoPlayer.play().catch((e) => console.error("Autoplay failed:", e));
}

export function stopPlayback(): void {
    if (!dom.videoPlayer) return;
    dom.videoPlayer.pause();
    dom.videoPlayer.removeAttribute("src");
    dom.videoPlayer.load();
}

export function navigateToVideo(video: Video): void {
    const savedTime = localStorage.getItem(STORAGE_KEY_PREFIX + video.filename);
    const startTime = savedTime && parseFloat(savedTime) > 0 ? Math.round(parseFloat(savedTime)) : 0;
    store.actions.playVideo(video, startTime);
}

export function navigateVideoInList(direction: 1 | -1): void {
    const { videoList, filter, currentVideo, lastPlayedVideo } = store.getState();
    const regex = filter ? new RegExp(filter, "i") : null;
    const filteredList = videoList.filter((video) => !regex || regex.test(video.filename));

    const activeVideo = currentVideo || lastPlayedVideo;
    if (!activeVideo) return;

    const currentIndex = filteredList.findIndex((v) => v.filename === activeVideo.filename && v.type === activeVideo.type);

    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < filteredList.length) {
        navigateToVideo(filteredList[nextIndex]);
    }
}
