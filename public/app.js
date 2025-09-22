// public/app.js
import { store } from './modules/store.js';
import * as ui from './modules/ui.js';
import * as player from './modules/player.js';

let dom = {};
let lastHashUpdateTime = 0;
let lastQuadrantTapTime = 0;
let wakeLock = null;

// --- Screen Wake Lock (for iOS screen dimming) ---
const requestWakeLock = async () => {
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.error(`Could not acquire wake lock: ${err.name}, ${err.message}`);
        }
    }
};

const releaseWakeLock = async () => {
    if (wakeLock !== null) {
        await wakeLock.release();
        wakeLock = null;
    }
};


// --- DOM Event Listeners (Dispatch actions to the store) ---
function attachEventListeners() {
    dom.goBackBtn.addEventListener('click', () => {
        window.location.hash = '#/';
    });

    dom.searchInput.addEventListener('input', (e) => {
        const oldFilter = store.getState().filter;
        const newFilter = e.target.value;
        store.actions.setFilter(newFilter);
        // If the filter was cleared, scroll to the top of the list
        if (oldFilter && !newFilter) {
            dom.listContainer.scrollTop = 0;
        }
    });

    dom.clearSearchBtn.addEventListener('click', () => {
        store.actions.setFilter('');
        dom.searchInput.value = '';
        dom.listContainer.scrollTop = 0;
        dom.searchInput.focus();
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

    // --- Double Tap Zoom Prevention ---
    // 1. Prevent default on dblclick, a more direct approach.
    dom.quadrantOverlay.addEventListener('dblclick', (e) => e.preventDefault());
    dom.videoPlayer.addEventListener('dblclick', (e) => e.preventDefault());
    
    // 2. Keep the manual detection as a fallback for certain iOS behaviors.
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
    
    dom.modeOrUndoBtn.addEventListener('click', () => {
        const { segments, playerMode, currentVideo } = store.getState();
        if (currentVideo?.type === 'original' && playerMode === 'edit' && segments.length > 0) {
            store.actions.removeLastSegment(); // Acts as Undo
        } else {
            store.actions.togglePlayerMode(); // Acts as Mode Toggle
        }
    });

    dom.deleteOrCutBtn.addEventListener('click', () => {
        const { segments } = store.getState();
        if (segments.length > 0) {
            store.actions.createEditedVideo(); // Acts as Cut
        } else {
            store.actions.deleteCurrentVideo(); // Acts as Delete
        }
    });


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

    // Re-acquire wake lock when tab becomes visible again
    document.addEventListener('visibilitychange', async () => {
        if (wakeLock !== null && document.visibilityState === 'visible') {
            await requestWakeLock();
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
        videoItemsWrapper: document.getElementById('videoItemsWrapper'),
        videoPlayer: document.getElementById('videoPlayer'),
        streamerNameEl: document.getElementById('streamerName'),
        searchInput: document.getElementById('searchInput'),
        clearSearchBtn: document.getElementById('clearSearchBtn'),
        getDurationsBtn: document.getElementById('getDurationsBtn'),
        quadrantOverlay: document.getElementById('quadrantOverlay'),
        topBar: document.getElementById('topBar'), // ADDED THIS LINE
        progressBar: document.getElementById('progressBar'),
        progressFill: document.getElementById('progressFill'),
        playerControlsContainer: document.getElementById('playerControlsContainer'),
        muteBtn: document.getElementById('muteBtn'),
        addPointBtn: document.getElementById('addPointBtn'),
        timeDisplay: document.getElementById('timeDisplay'),
        // New combined/repurposed buttons
        goBackBtn: document.getElementById('goBackBtn'),
        modeOrUndoBtn: document.getElementById('modeOrUndoBtn'),
        deleteOrCutBtn: document.getElementById('deleteOrCutBtn'),
    };

    // 2. Initialize modules
    ui.initUI(dom);
    player.initPlayer(dom);

    // 3. Subscribe the UI to state changes.
    // The `render` function will now be called automatically whenever state is updated.
    let lastPlayedVideoSrc = null;
    store.subscribe(state => {
        ui.render(state);

        // Control the video player and wake lock based on state changes
        const currentSrc = state.currentVideo ? `/video/${state.currentVideo.type}/${encodeURIComponent(state.currentVideo.filename)}` : null;
        if (lastPlayedVideoSrc !== currentSrc) {
            lastPlayedVideoSrc = currentSrc;
            if (state.currentVideo) {
                player.playVideo(state.currentVideo, state.currentVideoStartTime);
                requestWakeLock();
            } else {
                player.stopPlayback();
                releaseWakeLock();
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