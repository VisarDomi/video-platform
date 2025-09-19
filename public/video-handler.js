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
    
    if (!confirm(`Are you sure you want to move ${state.currentVideo.filename} to the trash?`)) return;

    state.processingVideos.add(state.currentVideo.filename);
    ui.updateProcessingStatusUI(state.currentVideo);

    api.sendDeleteRequest(state.currentVideo)
        .then(result => {
            if (!result.success) {
                alert(`Failed to delete ${state.currentVideo.filename}: ${result.message}`);
            } else {
                location.hash = '#/';
            }
        })
        .catch(error => {
            console.error(`Delete request failed for ${state.currentVideo.filename}:`, error);
            alert(`An error occurred while trying to delete the video ${state.currentVideo.filename}.`);
        })
        .finally(() => {
            state.processingVideos.delete(state.currentVideo.filename);
            if (state.currentVideo) ui.updateProcessingStatusUI(state.currentVideo);
        });
}

function handleCreate() {
    if (!state.currentVideo || state.currentVideo.type === 'edited' || state.segments.length === 0 || state.segments.length % 2 !== 0) return;

    state.processingVideos.add(state.currentVideo.filename);
    ui.updateProcessingStatusUI(state.currentVideo);

    api.sendEditRequest(state.currentVideo, state.segments)
        .then(result => {
            if (!result.success) {
                alert(`Failed to edit ${state.currentVideo.filename}: ${result.message}`);
            } else {
                const videoName = state.currentVideo.filename;
                player.stopPlayback();
                location.hash = `#/edited/${encodeURIComponent(videoName)}`;
            }
        })
        .catch(error => {
            console.error(`Edit request failed for ${state.currentVideo.filename}:`, error);
            alert(`An error occurred during the edit request for ${state.currentVideo.filename}.`);
        })
        .finally(() => {
            state.processingVideos.delete(state.currentVideo.filename);
            if (state.currentVideo) ui.updateProcessingStatusUI(state.currentVideo);
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