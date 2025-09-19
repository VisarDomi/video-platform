// public/app.js
import { store } from './modules/store.js';
import * as ui from './modules/ui.js';
import * as player from './modules/player.js';

let dom = {};
let lastHashUpdateTime = 0;

// --- DOM Event Listeners (Dispatch actions to the store) ---
function attachEventListeners() {
    dom.backBtn.addEventListener('click', () => {
        window.location.hash = '#/';
    });
    
    dom.searchInput.addEventListener('input', (e) => {
        store.actions.setFilter(e.target.value);
    });

    dom.muteBtn.addEventListener('click', () => {
        dom.videoPlayer.muted = !dom.videoPlayer.muted;
        dom.muteBtn.textContent = dom.videoPlayer.muted ? '🔇' : '🔊';
    });

    dom.quadrantOverlay.addEventListener('pointerdown', (e) => {
        const action = e.target.dataset.action;
        if (action === 'next') player.navigateVideoInList(1);
        if (action === 'prev') player.navigateVideoInList(-1);
    });
    dom.quadrantOverlay.addEventListener('contextmenu', e => e.preventDefault());
    
    dom.progressBar.addEventListener('click', (e) => {
        if (isNaN(dom.videoPlayer.duration)) return;
        const rect = dom.progressBar.getBoundingClientRect();
        dom.videoPlayer.currentTime = dom.videoPlayer.duration * ((e.clientX - rect.left) / dom.progressBar.offsetWidth);
    });

    dom.addPointBtn.addEventListener('click', () => {
        store.actions.addSegment(dom.videoPlayer.currentTime);
    });

    dom.deleteBtn.addEventListener('click', () => store.actions.deleteCurrentVideo());
    dom.createBtn.addEventListener('click', () => store.actions.createEditedVideo());

    // Video player events for UI updates
    dom.videoPlayer.addEventListener('timeupdate', handleTimeUpdate);
    dom.videoPlayer.addEventListener('loadedmetadata', () => {
        ui.render(store.getState()); // Re-render to show segment markers
        dom.muteBtn.textContent = dom.videoPlayer.muted ? '🔇' : '🔊';
    });
}

// --- App Logic ---
function handleTimeUpdate() {
    if (dom.videoPlayer.seeking) return;
    
    const { currentVideo } = store.getState();
    ui.updateProgressBar(dom.videoPlayer.currentTime, dom.videoPlayer.duration);

    if (!currentVideo) return;

    const now = Date.now();
    if (now - lastHashUpdateTime > 2000) { // Throttle updates
        lastHashUpdateTime = now;
        const currentTime = Math.round(dom.videoPlayer.currentTime);
        localStorage.setItem(player.STORAGE_KEY_PREFIX + currentVideo.filename, currentTime);

        const newHash = `#/${currentVideo.type}/${encodeURIComponent(currentVideo.filename)}/${currentTime}`;
        if (location.hash.startsWith(`#/${currentVideo.type}/${encodeURIComponent(currentVideo.filename)}`)) {
             history.replaceState(null, '', newHash);
        }
    }
}

// --- Router (Updates store based on URL) ---
async function handleRouteChange() {
    // Make sure the video list is loaded before routing.
    if (store.getState().isLoading) {
        await store.actions.loadVideoList();
    }
    
    const hash = window.location.hash || '#/';
    const parts = hash.slice(2).split('/');
    const [type, encodedName, time] = parts;
    const isVideoRoute = (type === 'original' || type === 'edited') && encodedName;
    
    let currentVideoState = store.getState().currentVideo;

    if (isVideoRoute) {
        const videoName = decodeURIComponent(encodedName);
        const startTime = parseFloat(time) || 0;
        const targetVideo = store.getState().videoList.find(v => v.filename === videoName && v.type === type);

        if (targetVideo) {
             // Only dispatch a play action if the video isn't already the current one
            if (currentVideoState?.filename !== targetVideo.filename || currentVideoState?.type !== targetVideo.type) {
                store.actions.playVideo(targetVideo, startTime);
            }
        } else {
            alert(`Could not find video "${videoName}". It may have been deleted.`);
            location.hash = '#/';
        }
    } else {
        // If we are on a video page and the hash changes to '#/', show the list.
        if (currentVideoState) {
            store.actions.showList();
        }
    }
}

// --- Initialization ---
function initialize() {
    // 1. Cache DOM elements
    dom = {
        listView: document.getElementById('listView'),
        videoView: document.getElementById('videoView'),
        listContainer: document.getElementById('listContainer'),
        videoPlayer: document.getElementById('videoPlayer'),
        streamerNameEl: document.getElementById('streamerName'),
        backBtn: document.getElementById('backBtn'),
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

    // 2. Initialize modules
    ui.initUI(dom);
    player.initPlayer(dom);
    
    // 3. Subscribe the UI to state changes.
    // The `render` function will now be called automatically whenever state is updated.
    let lastPlayedVideoSrc = null;
    store.subscribe(state => {
        ui.render(state);

        // Control the video player based on state changes
        const currentSrc = state.currentVideo ? `/video/${state.currentVideo.type}/${encodeURIComponent(state.currentVideo.filename)}` : null;
        if (lastPlayedVideoSrc !== currentSrc) {
            lastPlayedVideoSrc = currentSrc;
            if (state.currentVideo) {
                player.playVideo(state.currentVideo);
            } else {
                player.stopPlayback();
            }
        }
    });

    // 4. Set up event listeners and initial routing
    attachEventListeners();
    window.addEventListener('hashchange', handleRouteChange);
    store.actions.initialize().then(() => {
        handleRouteChange(); // Initial route handling
    });
}

document.addEventListener('DOMContentLoaded', initialize);