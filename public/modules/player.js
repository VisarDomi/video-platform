import { state, STORAGE_KEY_PREFIX } from './state.js';
import { showView, togglePlayerUI, updateProcessingStatusUI, renderSegmentMarkers } from './ui.js';

let dom = {};

export function initPlayer(elements) {
    dom = elements;
}

export function playVideo(video, startTime = 0) {
    if (!video) return;

    state.currentVideo = video;
    showView('video');
    dom.streamerNameEl.textContent = `Archive: ${video.filename}`;
    
    const isEditable = video.type === 'original';
    togglePlayerUI(true, isEditable);
    if (isEditable) {
        updateProcessingStatusUI(video);
    }

    dom.videoPlayer.controls = false;
    dom.videoPlayer.loop = false;
    dom.videoPlayer.src = `/video/${video.type}/${encodeURIComponent(video.filename)}`;
    
    state.segments = [];
    renderSegmentMarkers();

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
    state.currentVideo = null;
}

export function navigateToVideo(video) {
    const savedTime = localStorage.getItem(STORAGE_KEY_PREFIX + video.filename);
    let hash = `#/${video.type}/${encodeURIComponent(video.filename)}`;
    if (savedTime && parseFloat(savedTime) > 0) {
        hash += `/${Math.round(parseFloat(savedTime))}`;
    }
    location.hash = hash;
}

export function navigateVideoInList(direction) {
    const filter = dom.searchInput.value;
    const regex = filter ? new RegExp(filter, 'i') : null;
    const filteredList = state.videoList.filter(video => !regex || regex.test(video.filename));
    
    const currentIndex = filteredList.findIndex(v => v.filename === state.currentVideo.filename && v.type === state.currentVideo.type);
    
    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < filteredList.length) {
         navigateToVideo(filteredList[nextIndex]);
    }
}