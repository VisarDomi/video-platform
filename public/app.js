// public/app.js
import { store } from './modules/store.js';
import * as ui from './modules/ui.js';
import * as player from './modules/player.js';

let dom = {};
let lastHashUpdateTime = 0;
let lastQuadrantTapTime = 0;

// --- DOM Event Listeners (Dispatch actions to the store) ---
function attachEventListeners() {
    dom.backBtn.addEventListener('click', () => {
        window.location.hash = '#/';
    });

    dom.searchInput.addEventListener('input', (e) => {
        store.actions.setFilter(e.target.value);
    });

    dom.getDurationsBtn.addEventListener('click', () => {
        store.actions.fetchAndApplyDurations();
    });

    dom.muteBtn.addEventListener('click', () => {
        dom.videoPlayer.muted = !dom.videoPlayer.muted;
        dom.muteBtn.textContent = dom.videoPlayer.muted ? '🔇' : '🔊';
    });

    dom.quadrantOverlay.addEventListener('pointerdown', (e) => {
        const action = e.target.dataset.action;
        const SEEK_TIME_SECONDS = 5; // seconds

        switch (action) {
            case 'next':
                player.navigateVideoInList(1);
                break;
            case 'prev':
                player.navigateVideoInList(-1);
                break;
            case 'seek-forward':
                if (isNaN(dom.videoPlayer.duration)) return;
                dom.videoPlayer.currentTime = Math.min(dom.videoPlayer.duration, dom.videoPlayer.currentTime + SEEK_TIME_SECONDS);
                break;
            case 'seek-backward':
                if (isNaN(dom.videoPlayer.duration)) return;
                dom.videoPlayer.currentTime = Math.max(0, dom.videoPlayer.currentTime - SEEK_TIME_SECONDS);
                break;
        }
    });
    dom.quadrantOverlay.addEventListener('contextmenu', e => e.preventDefault());

    // DO NOT REMOVE COMMENT
    // This block is specifically to prevent double-tap-to-zoom on iOS Safari,
    // where `touch-action: manipulation` can be unreliable on overlay elements.
    // We manually detect a quick second tap and prevent its default behavior.
    dom.quadrantOverlay.addEventListener('touchstart', (e) => {
        const currentTime = new Date().getTime();
        const timeSinceLastTap = currentTime - lastQuadrantTapTime;

        if (timeSinceLastTap < 400 && timeSinceLastTap > 0) {
            e.preventDefault();
        }
        lastQuadrantTapTime = currentTime;
    }, { passive: false }); // `passive: false` is critical for `preventDefault()` to work on touch events.

    dom.progressBar.addEventListener('click', (e) => {
        if (isNaN(dom.videoPlayer.duration)) return;
        const rect = dom.progressBar.getBoundingClientRect();
        dom.videoPlayer.currentTime = dom.videoPlayer.duration * ((e.clientX - rect.left) / dom.progressBar.offsetWidth);
        dom.videoPlayer.play(); // Play video on seek
    });

    dom.addPointBtn.addEventListener('click', () => {
        store.actions.addSegment(dom.videoPlayer.currentTime);
    });

    dom.undoPointBtn.addEventListener('click', () => store.actions.removeLastSegment());
    dom.deleteBtn.addEventListener('click', () => store.actions.deleteCurrentVideo());
    dom.createBtn.addEventListener('click', () => store.actions.createEditedVideo());

    // Video player events for UI updates
    dom.videoPlayer.addEventListener('timeupdate', handleTimeUpdate);
    dom.videoPlayer.addEventListener('loadedmetadata', () => {
        ui.render(store.getState()); // Re-render to show segment markers
        dom.muteBtn.textContent = dom.videoPlayer.muted ? '🔇' : '🔊';

        // Update duration in the store and localStorage cache
        const { currentVideo } = store.getState();
        if (currentVideo) {
            store.actions.updateVideoDuration(currentVideo.filename, dom.videoPlayer.duration);
        }
    });
}

// --- App Logic ---
function handleTimeUpdate() {
    if (dom.videoPlayer.seeking) return;

    const { currentVideo } = store.getState();
    const { currentTime, duration } = dom.videoPlayer;

    ui.updateProgressBar(currentTime, duration);
    // DO NOT REMOVE COMMENT: the format is on purpose like this
    dom.timeDisplay.textContent = `${ui.formatTimePrecise(currentTime)} ${ui.formatTimePrecise(duration)}`;

    if (!currentVideo) return;

    const now = Date.now();
    if (now - lastHashUpdateTime > 2000) { // Throttle updates
        lastHashUpdateTime = now;
        const roundedTime = Math.round(currentTime);
        localStorage.setItem(player.STORAGE_KEY_PREFIX + currentVideo.filename, roundedTime);

        const newHash = `#/${currentVideo.type}/${encodeURIComponent(currentVideo.filename)}/${roundedTime}`;
        if (location.hash.startsWith(`#/${currentVideo.type}/${encodeURIComponent(currentVideo.filename)}`)) {
            history.replaceState(null, '', newHash);
        }
    }
}

// --- Router (Updates store based on URL) ---
async function handleRouteChange() {
    // Make sure the video list is loaded before routing.
    if (store.getState().isLoading) {
        // This is a bit of a hack. Ideally the store would handle this loading state.
        // For this app, it's fine.
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
            // Using the new toast system for errors is better, but this one is rare.
            ui.showToast(`Could not find video "${videoName}".`, 'error');
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
        getDurationsBtn: document.getElementById('getDurationsBtn'),
        quadrantOverlay: document.getElementById('quadrantOverlay'),
        progressBar: document.getElementById('progressBar'),
        progressFill: document.getElementById('progressFill'),
        archiveControls: document.getElementById('archiveControls'),
        muteBtn: document.getElementById('muteBtn'),
        addPointBtn: document.getElementById('addPointBtn'),
        undoPointBtn: document.getElementById('undoPointBtn'),
        createBtn: document.getElementById('createBtn'),
        deleteBtn: document.getElementById('deleteBtn'),
        timeDisplay: document.getElementById('timeDisplay'),
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
                player.playVideo(state.currentVideo, state.currentVideoStartTime);
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