// public/modules/player.js
import { store } from './store.js';

export const STORAGE_KEY_PREFIX = 'video-progress-';
let dom = {};

export function initPlayer(elements) {
    dom = elements;
}

export function playVideo(video, startTime = 0) {
    if (!video) {
        stopPlayback();
        return;
    }
    
    dom.videoPlayer.controls = false;
    dom.videoPlayer.loop = false;
    dom.videoPlayer.src = `/video/${video.type}/${encodeURIComponent(video.filename)}`;
    
    const seekOnLoad = () => {
        if (startTime > 0 && startTime < dom.videoPlayer.duration) {
            dom.videoPlayer.currentTime = startTime;
        }
        dom.videoPlayer.removeEventListener('loadedmetadata', seekOnLoad);
    };
    dom.videoPlayer.addEventListener('loadedmetadata', seekOnLoad);

    dom.videoPlayer.play().catch(e => console.error("Autoplay failed:", e));
}

export function stopPlayback() {
    if (!dom.videoPlayer) return;
    dom.videoPlayer.pause();
    dom.videoPlayer.removeAttribute('src');
    dom.videoPlayer.load();
}

/**
 * NEW, SIMPLIFIED VERSION
 * This function no longer changes the URL. It directly tells the store to play a video,
 * first checking localStorage for any saved progress.
 */
export function navigateToVideo(video) {
    const savedTime = localStorage.getItem(STORAGE_KEY_PREFIX + video.filename);
    const startTime = (savedTime && parseFloat(savedTime) > 0) ? Math.round(parseFloat(savedTime)) : 0;
    // Directly call the action instead of changing the hash
    store.actions.playVideo(video, startTime);
}

export function navigateVideoInList(direction) {
    const { videoList, filter, currentVideo, lastPlayedVideo } = store.getState();
    const regex = filter ? new RegExp(filter, 'i') : null;
    const filteredList = videoList.filter(video => !regex || regex.test(video.filename));
    
    const activeVideo = currentVideo || lastPlayedVideo;
    if (!activeVideo) return;

    const currentIndex = filteredList.findIndex(v => v.filename === activeVideo.filename && v.type === activeVideo.type);
    
    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < filteredList.length) {
         // This now calls the new, simplified navigateToVideo function
         navigateToVideo(filteredList[nextIndex]);
    }
}
