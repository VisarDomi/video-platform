import { state } from './state.js';
import { navigateToVideo } from './player.js';

let dom = {};

export function initUI(elements) {
    dom = elements;
}

export function updateProcessingStatusUI(video) {
    if (!video || !dom.createSegmentsBtn) return;

    if (state.processingVideos.has(video.filename)) {
        dom.createSegmentsBtn.textContent = 'Processing...';
        dom.createSegmentsBtn.disabled = true;
    } else {
        dom.createSegmentsBtn.textContent = 'Create/Delete';
        dom.createSegmentsBtn.disabled = false;
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

    filteredList.forEach(video => {
        const item = document.createElement('div');
        item.className = 'list-item archive-item';
        item.textContent = video.filename + (video.type === 'edited' ? ' (edited)' : '');
        item.addEventListener('click', () => navigateToVideo(video));
        dom.listContainer.appendChild(item);
    });
}

export function togglePlayerUI(show, isEditable = false) {
    dom.quadrantOverlay.classList.toggle('hidden', !show);
    dom.progressBar.classList.toggle('hidden', !show);
    dom.archiveControls.classList.toggle('hidden', !show);

    if (show) {
        dom.addPointBtn.classList.toggle('hidden', !isEditable);
        dom.createSegmentsBtn.classList.toggle('hidden', !isEditable);
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