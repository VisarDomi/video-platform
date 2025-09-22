// public/modules/ui.js
import { navigateToVideo } from './player.js';

let dom = {};

export function initUI(elements) {
    dom = elements;
}

/**
 * Formats duration in seconds for the video list (e.g., "12:34" or "1:02:34").
 * @param {number} seconds The total duration in seconds.
 * @returns {string} The formatted duration string.
 */
export function formatDuration(seconds) {
    if (isNaN(seconds) || seconds < 0) return '--:--';
    const totalSecondsInt = Math.floor(seconds);
    const h = Math.floor(totalSecondsInt / 3600);
    const m = Math.floor((totalSecondsInt % 3600) / 60).toString().padStart(2, '0');
    const s = (totalSecondsInt % 60).toString().padStart(2, '0');
    
    if (h > 0) {
        return `${h.toString()}:${m}:${s}`;
    }
    return `${m}:${s}`;
}


/**
 * Formats time in seconds with millisecond precision for the player UI.
 * @param {number} seconds The time in seconds.
 * @returns {string} The formatted time string (e.g., "01:23.456").
 */
export function formatTimePrecise(seconds) {
    if (isNaN(seconds)) return '00:00.000';
    
    // Calculate milliseconds from the fractional part of seconds
    const ms = Math.floor((seconds % 1) * 1000).toString().padStart(3, '0');
    
    // Use the integer part for H:M:S calculation
    const totalSecondsInt = Math.floor(seconds);
    const h = Math.floor(totalSecondsInt / 3600).toString().padStart(2, '0');
    const m = Math.floor((totalSecondsInt % 3600) / 60).toString().padStart(2, '0');
    const s = (totalSecondsInt % 60).toString().padStart(2, '0');
    
    const timeWithoutHours = `${m}:${s}.${ms}`;
    const timeWithHours = `${h}:${m}:${s}.${ms}`;

    return totalSecondsInt >= 3600 ? timeWithHours : timeWithoutHours;
}

export function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);

    // Animate out and remove
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, duration);
}

function renderVideoList(state) {
    // Target the new wrapper for video items, leaving the search bar alone.
    dom.videoItemsWrapper.innerHTML = '';
    
    const regex = state.filter ? new RegExp(state.filter, 'i') : null;
    const filteredList = state.videoList.filter(video => !regex || regex.test(video.filename));

    if (state.isLoading) {
        dom.videoItemsWrapper.innerHTML = '<p id="loadingMessage">Loading...</p>';
        return;
    }
    
    if (filteredList.length === 0) {
         dom.videoItemsWrapper.innerHTML = '<p class="info-message">No archived videos found.</p>';
         return;
    }

    const activeVideo = state.currentVideo || state.lastPlayedVideo;

    filteredList.forEach(video => {
        const item = document.createElement('div');
        item.className = 'list-item archive-item';
        item.addEventListener('click', () => navigateToVideo(video));

        const nameSpan = document.createElement('span');
        nameSpan.className = 'list-item-name';
        nameSpan.textContent = video.filename + (video.type === 'edited' ? ' (edited)' : '');
        
        const durationSpan = document.createElement('span');
        durationSpan.className = 'list-item-duration';
        durationSpan.textContent = video.duration ? formatDuration(video.duration) : '--:--';

        item.appendChild(nameSpan);
        item.appendChild(durationSpan);

        if (activeVideo && video.filename === activeVideo.filename && video.type === activeVideo.type) {
            item.classList.add('current-video');
        }

        dom.videoItemsWrapper.appendChild(item);
    });

    // The scroll target is now the wrapper's children.
    const currentItem = dom.videoItemsWrapper.querySelector('.current-video');
    if (currentItem) {
        currentItem.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
}

function renderPlayer(state) {
    const { currentVideo, segments, playerMode } = state;

    dom.quadrantOverlay.classList.toggle('hidden', !currentVideo);
    dom.progressBar.classList.toggle('hidden', !currentVideo);
    dom.playerControlsContainer.classList.toggle('hidden', !currentVideo);
    document.getElementById('timeDisplayContainer').classList.toggle('hidden', !currentVideo);

    if (currentVideo) {
        dom.streamerNameEl.textContent = `${currentVideo.filename}`;
        
        const isOriginal = currentVideo.type === 'original';
        const hasSegments = segments.length > 0;
        
        // Hide all conditional buttons by default, then show them based on state
        dom.modeOrUndoBtn.classList.add('hidden');
        dom.goBackBtn.classList.add('hidden');
        dom.addPointBtn.classList.add('hidden');
        dom.deleteOrCutBtn.classList.add('hidden');

        // Mute button is always visible when a video is playing
        dom.muteBtn.classList.remove('hidden');

        if (playerMode === 'view' || !isOriginal) {
            // VIEW MODE
            dom.goBackBtn.classList.remove('hidden');
            if (isOriginal) {
                // For original videos, show button to switch back to edit mode
                dom.modeOrUndoBtn.classList.remove('hidden');
                dom.modeOrUndoBtn.textContent = '✏️';
                dom.modeOrUndoBtn.title = 'Edit Mode';
            }
        } else {
            // EDIT MODE (only possible for original videos)
            dom.addPointBtn.classList.remove('hidden');

            if (hasSegments) {
                // Edit mode WITH points
                dom.modeOrUndoBtn.classList.remove('hidden');
                dom.modeOrUndoBtn.textContent = '↪️';
                dom.modeOrUndoBtn.title = 'Undo Last Point';
                
                dom.deleteOrCutBtn.classList.remove('hidden');
                dom.deleteOrCutBtn.textContent = '✂️';
                dom.deleteOrCutBtn.title = 'Create Cut';
                dom.deleteOrCutBtn.disabled = segments.length % 2 !== 0;

            } else {
                // Edit mode WITHOUT points
                dom.modeOrUndoBtn.classList.remove('hidden');
                dom.modeOrUndoBtn.textContent = '👁️';
                dom.modeOrUndoBtn.title = 'View Mode';

                dom.deleteOrCutBtn.classList.remove('hidden');
                dom.deleteOrCutBtn.textContent = '🗑️';
                dom.deleteOrCutBtn.title = 'Delete Video';
                dom.deleteOrCutBtn.disabled = false;
            }
        }
    }

    // Render segment markers on the progress bar
    document.querySelectorAll('.segment-marker').forEach(m => m.remove());
    // Render segment text inside the progress bar
    const segmentContainer = document.getElementById('segmentTextContainer');
    segmentContainer.innerHTML = '';

    if (currentVideo && !isNaN(dom.videoPlayer.duration)) {
        segments.forEach(point => {
            const marker = document.createElement('div');
            marker.className = 'segment-marker';
            const percentage = (point / dom.videoPlayer.duration) * 100;
            marker.style.left = `${percentage}%`;
            dom.progressBar.appendChild(marker);
        });

        for (let i = 0; i < segments.length; i += 2) {
            const row = document.createElement('div');
            row.className = 'segment-row';

            const startSpan = document.createElement('span');
            startSpan.className = 'segment-time-start';
            startSpan.textContent = `start: ${formatTimePrecise(segments[i])}`;
            row.appendChild(startSpan);

            if (segments[i + 1] !== undefined) {
                const endSpan = document.createElement('span');
                endSpan.className = 'segment-time-end';
                endSpan.textContent = `end: ${formatTimePrecise(segments[i + 1])}`;
                row.appendChild(endSpan);
            }
            segmentContainer.appendChild(row);
        }
    }
}

export function updateProgressBar(currentTime, duration) {
    if (isNaN(duration)) return;
    const percentage = (currentTime / duration) * 100;
    dom.progressFill.style.width = `${percentage}%`;
}


/**
 * The main render function. It's called every time the state changes.
 * It's responsible for updating the entire UI to match the current state.
 */
export function render(state) {
    // 1. Update view visibility
    dom.listView.classList.toggle('hidden', state.view !== 'list');
    dom.videoView.classList.toggle('hidden', state.view !== 'video');

    // 2. Update search input and clear button
    if (document.activeElement !== dom.searchInput) {
        dom.searchInput.value = state.filter;
    }
    dom.clearSearchBtn.classList.toggle('hidden', !state.filter);

    // 3. Render sub-components
    if (state.view === 'list') {
        renderVideoList(state);
    } else if (state.view === 'video') {
        renderPlayer(state);
    }
}