import { state } from './state.js';
import { navigateToVideo } from './player.js';

let dom = {};

export function initUI(elements) {
    dom = elements;
}

export function updateActionButtonsUI() {
    if (!dom.createBtn || !dom.deleteBtn) return;

    const hasSegments = state.segments.length > 0;
    
    // Show delete only if there are no segments
    dom.deleteBtn.classList.toggle('hidden', hasSegments);

    // Show create only if there are segments
    dom.createBtn.classList.toggle('hidden', !hasSegments);
    
    // Disable create if segment count is odd
    if (hasSegments) {
        const isEven = state.segments.length % 2 === 0;
        dom.createBtn.disabled = !isEven;
    }
}

export function showView(viewToShow) {
    dom.listView.classList.toggle('hidden', viewToShow !== 'list');
    dom.videoView.classList.toggle('hidden', viewToShow !== 'video');
}

export function renderVideoList() {
    dom.loadingMessage.style.display = 'none';
    dom.listContainer.innerHTML = '';
    
    const filter = dom.searchInput.value;
    const regex = filter ? new RegExp(filter, 'i') : null;
    const filteredList = state.videoList.filter(video => !regex || regex.test(video.filename));

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

        // Add highlighting for the current/last played video
        if (activeVideo && video.filename === activeVideo.filename && video.type === activeVideo.type) {
            item.classList.add('current-video');
        }

        dom.listContainer.appendChild(item);
    });

    // Scroll the highlighted item into view
    const currentItem = dom.listContainer.querySelector('.current-video');
    if (currentItem) {
        // Use 'auto' behavior so it happens instantly in the background
        currentItem.scrollIntoView({ block: 'center', behavior: 'auto' });
    }
}

export function togglePlayerUI(show, isEditable = false) {
    dom.quadrantOverlay.classList.toggle('hidden', !show);
    dom.progressBar.classList.toggle('hidden', !show);
    dom.archiveControls.classList.toggle('hidden', !show);

    if (show) {
        dom.addPointBtn.classList.toggle('hidden', !isEditable);
        if (isEditable) {
            updateActionButtonsUI();
        } else {
            dom.createBtn.classList.add('hidden');
            dom.deleteBtn.classList.add('hidden');
        }
    }
}

export function renderSegmentMarkers() {
    document.querySelectorAll('.segment-marker').forEach(m => m.remove());
    if (isNaN(dom.videoPlayer.duration)) return;

    state.segments.forEach(point => {
        const marker = document.createElement('div');
        marker.className = 'segment-marker';
        const percentage = (point / dom.videoPlayer.duration) * 100;
        marker.style.left = `${percentage}%`;
        dom.progressBar.appendChild(marker);
    });
}

export function updateProgressBar() {
    if (!state.currentVideo || isNaN(dom.videoPlayer.duration)) return;
    const percentage = (dom.videoPlayer.currentTime / dom.videoPlayer.duration) * 100;
    dom.progressFill.style.width = `${percentage}%`;
}