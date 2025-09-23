// public/app.js
import { store } from './modules/store.js';
import * as ui from './modules/ui.js';
import * as player from './modules/player.js';

let dom = {};
let lastHashUpdateTime = 0;
let lastVideoViewTapTime = 0;
let lastProgressBarTapTime = 0;
let wakeLock = null;
let isScrubbing = false;


// --- Screen Wake Lock (for iOS screen dimming) ---
// A tiny, silent, looping MP4 video data URI to prevent screen dimming on iOS
const silentVideoDataURI = "data:video/mp4;base64,AAAAHGZ0eXBNU05WAAACAE1TTlYxAAAPeG1vb3YAAABsbXZoZAAAAAAAAAAAAAAAAAAAA+gAAAAAAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAhhdWRpbyAAAAAEZHNtcAAAAAABAAAAAAAAAAAAAAACAAEAQAAAACBlZHRzAAAAAGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAhhhZHRhAAAAAUG1kNGEAAAAAAAAAAAAAAAADNAAAAZptZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAAPoAAAAAAAAVQBoZGxyAAAAAAAAAABzb3VuAAAAAAAAAAAAAAAAU291bmRIYW5kbGVyAAAAAQhtc3RhAAAAYnN0c2QAAAAAAAAAAQAAAEFlbXA0YQAAAAAAAAEAAAAAAAAAAAACABAAAAAYc3J0cwAAAAAAAAAAAAAAEAAAAQAAAGN0dHMAAAAAAAAAAAAAAAEAAAACAAAAABRzdHNjAAAAAAAAAAAAAAABAAAAAQAAAAEAAAABAAAAHHN0c3oAAAAAAAAAAAAAAAABAAAAEAAAAAxyZGNsAAAAAQAAAAMAAAAAGHN0Y28AAAAAAAAAAAAAAAEAAABkAAAAGGZyZWUAAAADGG1kYXQAAAAGg3cBAQAAAAAAAAAAAA==";
let noSleepVideo = null;

const requestWakeLock = async () => {
    // Use the modern Wake Lock API if available
    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
        } catch (err) {
            console.error(`Could not acquire Wake Lock: ${err.name}, ${err.message}`);
        }
        return;
    }

    // Fallback for browsers that don't support Wake Lock API (like Safari on iOS)
    if (!noSleepVideo) {
        noSleepVideo = document.createElement('video');
        noSleepVideo.setAttribute('playsinline', '');
        noSleepVideo.setAttribute('loop', '');
        noSleepVideo.style.display = 'none';
        noSleepVideo.src = silentVideoDataURI;
        document.body.appendChild(noSleepVideo);
    }
    try {
        await noSleepVideo.play();
    } catch(e) {
        console.error('Could not play silent video for wake lock fallback.', e);
    }
};

const releaseWakeLock = async () => {
    if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
    }

    if (noSleepVideo) {
        noSleepVideo.pause();
    }
};


function handleScrub(e) {
    if (isNaN(dom.videoPlayer.duration)) return;

    const rect = dom.progressBar.getBoundingClientRect();
    // Clamp the position to be within the bar's bounds
    const position = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const newTime = dom.videoPlayer.duration * (position / rect.width);

    // 1. Optimistic UI Update: Update the visuals instantly.
    ui.updateProgressBar(newTime, dom.videoPlayer.duration);
    dom.timeDisplay.textContent = `${ui.formatTimePrecise(newTime)} ${ui.formatTimePrecise(dom.videoPlayer.duration)}`;


    // 2. Update the actual video player time.
    dom.videoPlayer.currentTime = newTime;
}

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

    // --- NEW ---
    // Add a single click listener to the video view for visual feedback.
    // This event bubbles up from clicks on the quadrant overlay, progress bar, and buttons.
    dom.videoView.addEventListener('click', (e) => {
        // Only flash if the user clicks on an interactive area
        if (e.target.closest('#quadrantOverlay') || e.target.closest('#topBar')) {
            const { currentVideo, playerMode } = store.getState();
            if (!currentVideo) return;

            const isEditMode = playerMode === 'edit' && currentVideo.type === 'original';
            const finalOpacity = isEditMode ? '0.15' : '0';
            ui.flashTopBar(finalOpacity);
        }
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
                dom.videoPlayer.play(); // <-- ADD THIS LINE
                break;
        }
    });
    dom.quadrantOverlay.addEventListener('contextmenu', e => e.preventDefault());

    // --- Double Tap Zoom Prevention ---
    // Prevent double-tap zoom on the entire video viewing area, crucial for iOS.
    // The CSS `touch-action: manipulation` on #videoView is the primary fix.
    // This JS is a more aggressive fallback.
    dom.videoView.addEventListener('dblclick', (e) => e.preventDefault());
    dom.videoView.addEventListener('touchstart', (e) => {
        // Only prevent default if the target is not an interactive element within the top bar.
        if (e.target.closest('#topBar')) {
            return;
        }
        const currentTime = new Date().getTime();
        const timeSinceLastTap = currentTime - lastVideoViewTapTime;
        if (timeSinceLastTap < 400 && timeSinceLastTap > 0) {
            e.preventDefault();
        }
        lastVideoViewTapTime = currentTime;
    }, { passive: false });

    // --- NEW Zoom Prevention for Progress Bar ---
    dom.progressBar.addEventListener('dblclick', e => e.preventDefault());
    dom.progressBar.addEventListener('touchstart', (e) => {
        const currentTime = new Date().getTime();
        const timeSinceLastTap = currentTime - lastProgressBarTapTime;

        if (timeSinceLastTap < 400 && timeSinceLastTap > 0) {
            e.preventDefault();
        }
        lastProgressBarTapTime = currentTime;
    }, { passive: false }); // `passive: false` is critical for `preventDefault()` to work here.

    // --- NEW Scrubbing Logic ---
    const onPointerMove = (e) => {
        if (isScrubbing) {
            handleScrub(e);
        }
    };

    const onPointerUp = () => {
        if (isScrubbing) {
            isScrubbing = false;
            dom.videoPlayer.play(); // Resume playback when scrubbing is done
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
        }
    };

    dom.progressBar.addEventListener('pointerdown', (e) => {
        isScrubbing = true;
        handleScrub(e); // Handle the initial click position

        // Attach listeners to the window to allow dragging outside the progress bar
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
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

    dom.videoOkBtn.addEventListener('click', () => {
        store.actions.saveCurrentVideo();
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
        if (document.visibilityState === 'visible' && (wakeLock || noSleepVideo)) {
            // Re-request the lock if we were previously in a state that needed it
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
        videoOkBtn: document.getElementById('videoOkBtn'),
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