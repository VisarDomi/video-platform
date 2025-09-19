import { state, STORAGE_KEY_PREFIX } from './state.js';
import { showView, togglePlayerUI, renderSegmentMarkers, renderVideoList } from './ui.js';

let dom = {};

export function initPlayer(elements) {
    dom = elements;
}

export function playVideo(video, startTime = 0) {
    if (!video) return;

    state.currentVideo = video;
    state.lastPlayedVideo = video; // Set the last played video here
    
    // --- ADDED LINE ---
    // Save the last played video identifier to localStorage
    try {
        localStorage.setItem('last-played-video', JSON.stringify(video));
    } catch (e) {
        console.error("Failed to save last played video to localStorage", e);
    }
    // --- END ADDED LINE ---

    showView('video');
    dom.streamerNameEl.textContent = `Archive: ${video.filename}`;
    
    const isEditable = video.type === 'original';
    togglePlayerUI(true, isEditable);

    // Re-render the list in the background to update highlight and scroll
    renderVideoList();

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
    state.currentVideo = null; // Only clear the current video, not the last played
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
    
    // Use lastPlayedVideo as a fallback if currentVideo is null
    const activeVideo = state.currentVideo || state.lastPlayedVideo;
    if (!activeVideo) return;

    const currentIndex = filteredList.findIndex(v => v.filename === activeVideo.filename && v.type === activeVideo.type);
    
    const nextIndex = currentIndex + direction;
    if (nextIndex >= 0 && nextIndex < filteredList.length) {
         navigateToVideo(filteredList[nextIndex]);
    }
}