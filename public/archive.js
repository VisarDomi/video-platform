const ArchiveHandler = (() => {
    // --- STATE ---
    let state = {
        videoList: [], // Array of objects: { filename, type }
        currentVideo: null, // The { filename, type } object of the currently playing video
        segments: [],
        seekInterval: null,
        processingVideos: new Set(), // To track videos being edited/deleted
    };
    
    // --- CONSTANTS ---
    const STORAGE_KEY_PREFIX = 'video-progress-';

    // --- DOM ELEMENTS (cached in init()) ---
    let dom = {};

    // =================================================================================
    // API CALLS
    // =================================================================================

    async function fetchVideos() {
        try {
            const response = await fetch(`/api/videos`);
            if (!response.ok) throw new Error(`Server responded with ${response.status}`);
            state.videoList = await response.json();
            return state.videoList;
        } catch (error) {
            console.error('Failed to load archive video list:', error);
            dom.listContainer.innerHTML = `<p class="info-message">Could not load archived videos.</p>`;
            return null;
        }
    }

    function sendDeleteRequest(video) {
        if (!confirm(`Are you sure you want to permanently DELETE "${video.filename}"?`)) return;
        
        state.processingVideos.add(video.filename);
        updateProcessingStatusUI(video);

        fetch(`/api/videos/${video.type}/${encodeURIComponent(video.filename)}`, {
            method: 'DELETE',
        })
        .then(response => response.json())
        .then(result => {
            if (!result.success) {
                alert(`Failed to delete: ${result.message}`);
            }
            // On success, do nothing (fire-and-forget).
        })
        .catch(error => {
            console.error('Delete request failed:', error);
            alert('An error occurred while trying to delete the video.');
        })
        .finally(() => {
            state.processingVideos.delete(video.filename);
            // If we are still on the same video, update its UI
            if (state.currentVideo && state.currentVideo.filename === video.filename) {
                updateProcessingStatusUI(state.currentVideo);
            }
        });
    }

    function sendEditRequest(video, segments) {
        if (segments.length % 2 !== 0) {
            return alert('You must have an even number of points (a start and end for each segment).');
        }
        const segmentPairs = [];
        for (let i = 0; i < segments.length; i += 2) {
            segmentPairs.push({ start: segments[i], end: segments[i + 1] });
        }
        
        state.processingVideos.add(video.filename);
        updateProcessingStatusUI(video);

        fetch('/api/edit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: video.filename, segments: segmentPairs }) 
        })
        .then(response => response.json())
        .then(result => {
            if (!result.success) {
                alert(`Failed to edit: ${result.message}`);
            }
            // On success, do nothing (fire-and-forget).
        })
        .catch(error => {
            console.error('Edit request failed:', error);
            alert('An error occurred during the edit request.');
        })
        .finally(() => {
            state.processingVideos.delete(video.filename);
            // If we are still on the same video, update its UI
            if (state.currentVideo && state.currentVideo.filename === video.filename) {
                updateProcessingStatusUI(state.currentVideo);
            }
        });
    }

    // =================================================================================
    // UI HELPERS
    // =================================================================================

    function updateProcessingStatusUI(video) {
        if (!video || !dom.createSegmentsBtn) return;

        if (state.processingVideos.has(video.filename)) {
            dom.createSegmentsBtn.textContent = 'Processing...';
            dom.createSegmentsBtn.disabled = true;
        } else {
            dom.createSegmentsBtn.textContent = 'Create/Delete';
            dom.createSegmentsBtn.disabled = false;
        }
    }

    function showView(viewToShow) {
        dom.listView.classList.toggle('hidden', viewToShow !== 'list');
        dom.videoView.classList.toggle('hidden', viewToShow !== 'video');
    }

    function renderVideoList() {
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

    function togglePlayerUI(show, isEditable = false) {
        dom.quadrantOverlay.classList.toggle('hidden', !show);
        dom.progressBar.classList.toggle('hidden', !show);
        dom.archiveControls.classList.toggle('hidden', !show);

        if (show) {
            dom.addPointBtn.classList.toggle('hidden', !isEditable);
            dom.createSegmentsBtn.classList.toggle('hidden', !isEditable);
        }
    }
    
    function renderSegmentMarkers() {
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

    // =================================================================================
    // PLAYER LOGIC
    // =================================================================================
    
    function playVideo(video, startTime = 0) {
        if (!video) return;

        state.currentVideo = video;
        showView('video');
        dom.streamerNameEl.textContent = `Archive: ${video.filename}`;
        
        const isEditable = video.type === 'original';
        togglePlayerUI(true, isEditable);
        if (isEditable) {
            updateProcessingStatusUI(video);
        }

        dom.videoPlayer.controls = false;
        dom.videoPlayer.loop = false;
        dom.videoPlayer.src = `/video/${video.type}/${encodeURIComponent(video.filename)}`;
        
        state.segments = [];
        renderSegmentMarkers();

        const seekOnLoad = () => {
            if (startTime > 0 && startTime < dom.videoPlayer.duration) {
                dom.videoPlayer.currentTime = startTime;
            }
            dom.videoPlayer.removeEventListener('loadedmetadata', seekOnLoad);
        };
        dom.videoPlayer.addEventListener('loadedmetadata', seekOnLoad);

        dom.videoPlayer.play().catch(e => console.error("Autoplay failed:", e));
    }
    
    function stopPlayback() {
        if (!dom.videoPlayer) return;
        dom.videoPlayer.pause();
        dom.videoPlayer.removeAttribute('src');
        dom.videoPlayer.load();
        state.currentVideo = null;
    }

    function navigateToVideo(video) {
        const savedTime = localStorage.getItem(STORAGE_KEY_PREFIX + video.filename);
        let hash = `#/archive/${video.type}/${encodeURIComponent(video.filename)}`;
        if (savedTime && parseFloat(savedTime) > 0) {
            hash += `/${Math.round(parseFloat(savedTime))}`;
        }
        location.hash = hash;
    }

    function navigateVideoInList(direction) {
        const filter = dom.searchInput.value;
        const regex = filter ? new RegExp(filter, 'i') : null;
        const filteredList = state.videoList.filter(video => !regex || regex.test(video.filename));
        
        const currentIndex = filteredList.findIndex(v => v.filename === state.currentVideo.filename && v.type === state.currentVideo.type);
        
        const nextIndex = currentIndex + direction;
        if (nextIndex >= 0 && nextIndex < filteredList.length) {
             navigateToVideo(filteredList[nextIndex]);
        }
    }

    // =================================================================================
    // PUBLIC INTERFACE & INITIALIZATION
    // =================================================================================

    async function showListPage() {
        showView('list');
        dom.loadingMessage.style.display = 'block';
        if (await fetchVideos()) {
            renderVideoList();
        }
    }

    async function playVideoByName(type, videoName, startTime) {
        await fetchVideos(); // Ensure we have the latest list
        const video = state.videoList.find(v => v.filename === videoName && v.type === type);
        if (video) {
            playVideo(video, startTime);
        } else {
            console.warn(`Could not find video "${videoName}" of type "${type}".`);
            alert(`Could not find video "${videoName}". It may have been deleted or moved.`);
            location.hash = '#/archive';
        }
    }

    function init(elements) {
        // Cache all DOM elements
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

        // --- Event Listeners ---
        dom.searchInput.addEventListener('input', () => {
             if (location.hash === '#/archive' || location.hash === '') {
                 renderVideoList();
             }
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
                case 'next': navigateVideoInList(1); break;
                case 'prev': navigateVideoInList(-1); break;
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

        let lastHashUpdateTime = 0;
        dom.videoPlayer.addEventListener('timeupdate', () => {
            if (!state.currentVideo || isNaN(dom.videoPlayer.duration) || dom.videoPlayer.seeking) return;
            
            const percentage = (dom.videoPlayer.currentTime / dom.videoPlayer.duration) * 100;
            dom.progressFill.style.width = `${percentage}%`;

            const now = Date.now();
            if (now - lastHashUpdateTime > 2000) { // Throttle updates
                lastHashUpdateTime = now;
                const video = state.currentVideo;
                const currentTime = Math.round(dom.videoPlayer.currentTime);
                localStorage.setItem(STORAGE_KEY_PREFIX + video.filename, currentTime);

                const newHash = `#/archive/${video.type}/${encodeURIComponent(video.filename)}/${currentTime}`;
                if (location.hash.startsWith(`#/archive/${video.type}/${encodeURIComponent(video.filename)}`)) {
                     history.replaceState(null, '', newHash);
                }
            }
        });

        dom.videoPlayer.addEventListener('loadedmetadata', () => {
            renderSegmentMarkers();
            dom.muteBtn.textContent = dom.videoPlayer.muted ? 'Unmute' : 'Mute';
        });

        dom.addPointBtn.addEventListener('click', () => {
            state.segments.push(dom.videoPlayer.currentTime);
            state.segments.sort((a, b) => a - b);
            renderSegmentMarkers();
        });
        
        dom.createSegmentsBtn.addEventListener('click', () => {
            if (!state.currentVideo) return;
            if (state.currentVideo.type === 'edited') {
                return alert('Cannot edit an already edited video.');
            }
            if (state.segments.length === 0) {
                sendDeleteRequest(state.currentVideo);
            } else {
                sendEditRequest(state.currentVideo, state.segments);
            }
        });
    }

    return { init, showListPage, playVideoByName, stopPlayback };
})();