import { state, STORAGE_KEY_PREFIX } from './modules/state.js';
import * as api from './modules/api.js';
import * as ui from './modules/ui.js';
import * as player from './modules/player.js';

let dom = {};
let lastHashUpdateTime = 0;

// --- Main Public Functions (for the router) ---

export async function showListPage() {
    ui.showView('list');
    dom.loadingMessage.style.display = 'block';
    try {
        state.videoList = await api.fetchVideos();
        ui.renderVideoList();
    } catch (error) {
        console.error('Failed to load archive video list:', error);
        dom.listContainer.innerHTML = `<p class="info-message">Could not load archived videos.</p>`;
    }
}

export async function playVideoByName(type, videoName, startTime) {
    // Ensure we have the latest list, in case a video was just edited/deleted
    try {
        state.videoList = await api.fetchVideos();
        const video = state.videoList.find(v => v.filename === videoName && v.type === type);
        if (video) {
            player.playVideo(video, startTime);
        } else {
            console.warn(`Could not find video "${videoName}" of type "${type}".`);
            alert(`Could not find video "${videoName}". It may have been deleted or moved.`);
            location.hash = '#/';
        }
    } catch (error) {
        alert('Could not fetch video list. Please try again.');
        location.hash = '#/';
    }
}

export function stopPlayback() {
    player.stopPlayback();
}

// --- Event Handlers ---

function handleDelete() {
    if (!state.currentVideo || state.currentVideo.type === 'edited' || state.segments.length > 0) return;

    // --- NEW "FIRE AND FORGET" LOGIC ---

    // 1. Capture the video to delete and find its position in the current list
    const videoToDelete = state.currentVideo;
    const filter = dom.searchInput.value;
    const regex = filter ? new RegExp(filter, 'i') : null;
    const currentFilteredList = state.videoList.filter(video => !regex || regex.test(video.filename));
    const currentIndex = currentFilteredList.findIndex(v => v.filename === videoToDelete.filename && v.type === videoToDelete.type);

    // 2. Immediately remove the video from the local state for a snappy UI.
    state.videoList = state.videoList.filter(v => !(v.filename === videoToDelete.filename && v.type === videoToDelete.type));
    const newFilteredList = state.videoList.filter(video => !regex || regex.test(video.filename));

    // 3. Immediately navigate to the next video (or home if the list is empty).
    if (newFilteredList.length === 0) {
        state.currentVideo = null;
        location.hash = '#/';
    } else {
        const nextIndex = Math.min(currentIndex, newFilteredList.length - 1);
        player.navigateToVideo(newFilteredList[nextIndex]);
    }

    // 4. Send the delete request in the background. We don't wait for it.
    // We only log an error if it fails, as the UI has already moved on.
    api.sendDeleteRequest(videoToDelete)
        .catch(error => {
            console.error(`Background delete request failed for ${videoToDelete.filename}:`, error);
            // We could alert the user here, but it might be confusing.
            // For a single-user app, just logging the error is often enough.
        });
}


function handleCreate() {
    if (!state.currentVideo || state.currentVideo.type === 'edited' || state.segments.length === 0 || state.segments.length % 2 !== 0) return;

    // --- FIRE AND FORGET LOGIC (mirrors handleDelete) ---

    // 1. Capture the video to edit, its segments, and find its position in the list.
    const videoToEdit = state.currentVideo;
    const savedSegments = [...state.segments]; // Segments are cleared on navigation.
    const filter = dom.searchInput.value;
    const regex = filter ? new RegExp(filter, 'i') : null;
    const currentFilteredList = state.videoList.filter(video => !regex || regex.test(video.filename));
    const currentIndex = currentFilteredList.findIndex(v => v.filename === videoToEdit.filename && v.type === videoToEdit.type);

    // 2. Immediately remove the original video from the local state for a snappy UI.
    // The new 'edited' version will appear on the next full list refresh.
    state.videoList = state.videoList.filter(v => !(v.filename === videoToEdit.filename && v.type === videoToEdit.type));
    const newFilteredList = state.videoList.filter(video => !regex || regex.test(video.filename));

    // 3. Immediately navigate to the next video (or home if the list is empty).
    if (newFilteredList.length === 0) {
        state.currentVideo = null;
        location.hash = '#/';
    } else {
        const nextIndex = Math.min(currentIndex, newFilteredList.length - 1);
        player.navigateToVideo(newFilteredList[nextIndex]);
    }

    // 4. Send the edit request in the background. We don't wait for it.
    // We only log an error if it fails, as the UI has already moved on.
    api.sendEditRequest(videoToEdit, savedSegments)
        .catch(error => {
            console.error(`Background edit request failed for ${videoToEdit.filename}:`, error);
            // In a real-world app, you might want to notify the user that the background
            // task failed, but for this request, just logging is fine.
        });
}


function handleTimeUpdate() {
    if (!state.currentVideo || dom.videoPlayer.seeking) return;
    
    ui.updateProgressBar();

    const now = Date.now();
    if (now - lastHashUpdateTime > 2000) { // Throttle updates
        lastHashUpdateTime = now;
        const video = state.currentVideo;
        const currentTime = Math.round(dom.videoPlayer.currentTime);
        localStorage.setItem(STORAGE_KEY_PREFIX + video.filename, currentTime);

        const newHash = `#/${video.type}/${encodeURIComponent(video.filename)}/${currentTime}`;
        if (location.hash.startsWith(`#/${video.type}/${encodeURIComponent(video.filename)}`)) {
             history.replaceState(null, '', newHash);
        }
    }
}

// --- Initialization ---

export function init(elements) {
    // --- ADDED BLOCK ---
    // Restore the last played video from localStorage on startup
    try {
        const savedLastVideo = localStorage.getItem('last-played-video');
        if (savedLastVideo) {
            state.lastPlayedVideo = JSON.parse(savedLastVideo);
        }
    } catch (e) {
        console.error("Failed to load last played video from localStorage", e);
        // If data is corrupted, clear it.
        localStorage.removeItem('last-played-video');
    }
    // --- END ADDED BLOCK ---

    // Cache DOM elements and initialize modules
    dom = {
        ...elements,
        searchInput: document.getElementById('searchInput'),
        quadrantOverlay: document.getElementById('quadrantOverlay'),
        progressBar: document.getElementById('progressBar'),
        progressFill: document.getElementById('progressFill'),
        archiveControls: document.getElementById('archiveControls'),
        muteBtn: document.getElementById('muteBtn'),
        addPointBtn: document.getElementById('addPointBtn'),
        createBtn: document.getElementById('createBtn'),
        deleteBtn: document.getElementById('deleteBtn'),
    };
    ui.initUI(dom);
    player.initPlayer(dom);

    // --- Attach Event Listeners ---
    dom.searchInput.addEventListener('input', () => {
         if (location.hash === '#/' || location.hash === '') ui.renderVideoList();
    });

    dom.muteBtn.addEventListener('click', () => {
        dom.videoPlayer.muted = !dom.videoPlayer.muted;
        dom.muteBtn.textContent = dom.videoPlayer.muted ? '🔇' : '🔊';
    });

    dom.quadrantOverlay.addEventListener('pointerdown', (e) => {
        const action = e.target.dataset.action;
        switch (action) {
            case 'next': player.navigateVideoInList(1); break;
            case 'prev': player.navigateVideoInList(-1); break;
        }
    });
    
    dom.quadrantOverlay.addEventListener('contextmenu', e => e.preventDefault());
    
    dom.progressBar.addEventListener('click', (e) => {
        if (isNaN(dom.videoPlayer.duration)) return;
        const rect = dom.progressBar.getBoundingClientRect();
        dom.videoPlayer.currentTime = dom.videoPlayer.duration * ((e.clientX - rect.left) / dom.progressBar.offsetWidth);
    });

    dom.videoPlayer.addEventListener('timeupdate', handleTimeUpdate);
    dom.videoPlayer.addEventListener('loadedmetadata', () => {
        ui.renderSegmentMarkers();
        dom.muteBtn.textContent = dom.videoPlayer.muted ? '🔇' : '🔊';
    });

    dom.addPointBtn.addEventListener('click', () => {
        state.segments.push(dom.videoPlayer.currentTime);
        state.segments.sort((a, b) => a - b);
        ui.renderSegmentMarkers();
        ui.updateActionButtonsUI();
    });
    
    dom.deleteBtn.addEventListener('click', handleDelete);
    dom.createBtn.addEventListener('click', handleCreate);
}