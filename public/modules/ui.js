// public/modules/ui.js
import { navigateToVideo } from './player.js';

let dom = {};

export function initUI(elements) {
    dom = elements;
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

    if (currentVideo) {
        dom.streamerNameEl.textContent = `Archive: ${currentVideo.filename}`;
        
        dom.addPointBtn.classList.toggle('hidden', !isEditable);
        if (isEditable) {
            const hasSegments = segments.length > 0;
            dom.deleteBtn.classList.toggle('hidden', hasSegments);
            dom.createBtn.classList.toggle('hidden', !hasSegments);
            dom.createBtn.disabled = segments.length % 2 !== 0;
        } else {
            dom.createBtn.classList.add('hidden');
            dom.deleteBtn.classList.add('hidden');
        }
    }

    // Render segment markers
    document.querySelectorAll('.segment-marker').forEach(m => m.remove());
    if (currentVideo && !isNaN(dom.videoPlayer.duration)) {
        segments.forEach(point => {
            const marker = document.createElement('div');
            marker.className = 'segment-marker';
            const percentage = (point / dom.videoPlayer.duration) * 100;
            marker.style.left = `${percentage}%`;
            dom.progressBar.appendChild(marker);
        });
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