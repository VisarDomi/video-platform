// public/modules/ui.js
import { navigateToVideo } from './player.js';

let dom = {};

export function initUI(elements) {
    dom = elements;
}

export function formatTime(seconds) {
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
    dom.listContainer.innerHTML = '';
    
    const regex = state.filter ? new RegExp(state.filter, 'i') : null;
    const filteredList = state.videoList.filter(video => !regex || regex.test(video.filename));

    if (state.isLoading) {
        dom.listContainer.innerHTML = '<p id="loadingMessage">Loading...</p>';
        return;
    }
    
    if (filteredList.length === 0) {
         dom.listContainer.innerHTML = '<p class="info-message">No archived videos found.</p>';
         return;
    }

    const activeVideo = state.currentVideo || state.lastPlayedVideo;

    filteredList.forEach(video => {
        const item = document.createElement('div');
        item.className = 'list-item archive-item';
        item.textContent = video.filename + (video.type === 'edited' ? ' (edited)' : '');
        item.addEventListener('click', () => navigateToVideo(video));

        if (activeVideo && video.filename === activeVideo.filename && video.type === activeVideo.type) {
            item.classList.add('current-video');
        }

        dom.listContainer.appendChild(item);
    });

    const currentItem = dom.listContainer.querySelector('.current-video');
    if (currentItem) {
        currentItem.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
}

function renderPlayer(state) {
    const { currentVideo, segments } = state;
    const isEditable = currentVideo?.type === 'original';

    dom.quadrantOverlay.classList.toggle('hidden', !currentVideo);
    dom.progressBar.classList.toggle('hidden', !currentVideo);
    dom.archiveControls.classList.toggle('hidden', !currentVideo);
    document.getElementById('timeDisplayContainer').classList.toggle('hidden', !currentVideo);

    if (currentVideo) {
        dom.streamerNameEl.textContent = `${currentVideo.filename}`;
        
        // Hide all conditional edit controls by default
        dom.addPointBtn.classList.add('hidden');
        dom.undoPointBtn.classList.add('hidden');
        dom.createBtn.classList.add('hidden');
        dom.deleteBtn.classList.add('hidden');

        // Hide the back button when editing
        dom.backBtn.classList.toggle('hidden', segments.length > 0);

        if (isEditable) {
            const hasSegments = segments.length > 0;
            
            // "Add Point" is always visible for an editable video
            dom.addPointBtn.classList.remove('hidden');

            if (hasSegments) {
                // State 2: Points exist. Show Undo and Create.
                dom.undoPointBtn.classList.remove('hidden');
                dom.createBtn.classList.remove('hidden');
                // The create button is visible but disabled if segments aren't paired
                dom.createBtn.disabled = segments.length % 2 !== 0;
            } else {
                // State 1: No points. Show Delete.
                dom.deleteBtn.classList.remove('hidden');
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
            startSpan.textContent = `start: ${formatTime(segments[i])}`;
            row.appendChild(startSpan);

            if (segments[i + 1] !== undefined) {
                const endSpan = document.createElement('span');
                endSpan.className = 'segment-time-end';
                endSpan.textContent = `end: ${formatTime(segments[i + 1])}`;
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

    // 2. Update search input
    if (document.activeElement !== dom.searchInput) {
        dom.searchInput.value = state.filter;
    }

    // 3. Render sub-components
    if (state.view === 'list') {
        renderVideoList(state);
    } else if (state.view === 'video') {
        renderPlayer(state);
    }
}