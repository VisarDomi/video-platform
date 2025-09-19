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

function handleEditOrDelete() {
    if (!state.currentVideo) return;
    if (state.currentVideo.type === 'edited') {
        return alert('Cannot edit an already edited video.');
    }

    if (state.segments.length === 0) {
        state.processingVideos.add(state.currentVideo.filename);
        ui.updateProcessingStatusUI(state.currentVideo);

        api.sendDeleteRequest(state.currentVideo)
            .then(result => { if (!result.success) alert(`Failed to delete ${state.currentVideo.filename}: ${result.message}`); })
            .catch(error => {
                console.error(`Delete request failed ${state.currentVideo.filename}:`, error);
                alert(`An error occurred while trying to delete the video ${state.currentVideo.filename}.`);
            })
            .finally(() => {
                state.processingVideos.delete(state.currentVideo.filename);
                if (state.currentVideo) ui.updateProcessingStatusUI(state.currentVideo);
            });

    } else {
        if (state.segments.length % 2 !== 0) {
            return alert('You must have an even number of points (a start and end for each segment).');
        }
        state.processingVideos.add(state.currentVideo.filename);
        ui.updateProcessingStatusUI(state.currentVideo);

        api.sendEditRequest(state.currentVideo, state.segments)
            .then(result => { if (!result.success) alert(`Failed to edit ${state.currentVideo.filename}: ${result.message}`); })
            .catch(error => {
                console.error(`Edit request failed ${state.currentVideo.filename}:`, error);
                alert(`An error occurred during the edit request ${state.currentVideo.filename}.`);
            })
            .finally(() => {
                state.processingVideos.delete(state.currentVideo.filename);
                if (state.currentVideo) ui.updateProcessingStatusUI(state.currentVideo);
            });
    }
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
        createSegmentsBtn: document.getElementById('createSegmentsBtn'),
    };
    ui.initUI(dom);
    player.initPlayer(dom);

    // --- Attach Event Listeners ---
    dom.searchInput.addEventListener('input', () => {
         if (location.hash === '#/' || location.hash === '') ui.renderVideoList();
    });

    dom.muteBtn.addEventListener('click', () => {
        dom.videoPlayer.muted = !dom.videoPlayer.muted;
        dom.muteBtn.textContent = dom.videoPlayer.muted ? 'Unmute' : 'Mute';
    });

    dom.quadrantOverlay.addEventListener('pointerdown', (e) => {
        if (state.seekInterval) clearInterval(state.seekInterval);
        const action = e.target.dataset.action;
        const seekAmount = 5;

        const performSeek = (direction) => {
            dom.videoPlayer.currentTime += seekAmount * direction;
            if (dom.videoPlayer.paused) dom.videoPlayer.play().catch(e => {});
            state.seekInterval = setInterval(() => { dom.videoPlayer.currentTime += seekAmount * direction; }, 200);
        };

        switch (action) {
            case 'seek-forward': performSeek(1); break;
            case 'seek-back': performSeek(-1); break;
            case 'next': player.navigateVideoInList(1); break;
            case 'prev': player.navigateVideoInList(-1); break;
        }
    });
    
    const stopSeeking = () => { if (state.seekInterval) { clearInterval(state.seekInterval); state.seekInterval = null; } };
    dom.quadrantOverlay.addEventListener('pointerup', stopSeeking);
    dom.quadrantOverlay.addEventListener('pointerleave', stopSeeking);
    dom.quadrantOverlay.addEventListener('contextmenu', e => e.preventDefault());
    
    dom.progressBar.addEventListener('click', (e) => {
        if (isNaN(dom.videoPlayer.duration)) return;
        const rect = dom.progressBar.getBoundingClientRect();
        dom.videoPlayer.currentTime = dom.videoPlayer.duration * ((e.clientX - rect.left) / dom.progressBar.offsetWidth);
    });

    dom.videoPlayer.addEventListener('timeupdate', handleTimeUpdate);
    dom.videoPlayer.addEventListener('loadedmetadata', () => {
        ui.renderSegmentMarkers();
        dom.muteBtn.textContent = dom.videoPlayer.muted ? 'Unmute' : 'Mute';
    });

    dom.addPointBtn.addEventListener('click', () => {
        state.segments.push(dom.videoPlayer.currentTime);
        state.segments.sort((a, b) => a - b);
        ui.renderSegmentMarkers();
    });
    
    dom.createSegmentsBtn.addEventListener('click', handleEditOrDelete);
}