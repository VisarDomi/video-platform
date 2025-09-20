// public/modules/store.js
import * as api from './api.js';
import { navigateToVideo } from './player.js';
import { showToast } from './ui.js';

const STORAGE_KEY_LAST_VIDEO = 'last-played-video';
const STORAGE_KEY_DURATIONS = 'video-durations';

// --- Private State ---
let state = {
    view: 'list', // 'list' or 'video'
    isLoading: true,
    videoList: [],
    filter: '',
    currentVideo: null,
    currentVideoStartTime: 0,
    lastPlayedVideo: null,
    segments: [],
};
let isFetchingDurations = false;
let cachedDurations = {};

// --- Listener Pattern ---
// Allows other parts of the app to "subscribe" to state changes
const listeners = new Set();
function notify() {
    // Pass a read-only copy of the state to listeners
    listeners.forEach(listener => listener({ ...state }));
}

// --- Internal Logic ---
function findNextVideoAfterChange(videoToChange, originalList) {
    const filter = state.filter;
    const regex = filter ? new RegExp(filter, 'i') : null;
    const currentFilteredList = originalList.filter(video => !regex || regex.test(video.filename));
    const currentIndex = currentFilteredList.findIndex(v => v.filename === videoToChange.filename && v.type === videoToChange.type);

    // Create the new list *after* finding the index in the old one
    const newList = state.videoList.filter(v => !(v.filename === videoToChange.filename && v.type === videoToChange.type));
    const newFilteredList = newList.filter(video => !regex || regex.test(video.filename));

    if (newFilteredList.length === 0) {
        return null;
    }
    const nextIndex = Math.min(currentIndex, newFilteredList.length - 1);
    return newFilteredList[nextIndex];
}

// --- Public API (Actions & Getters) ---
export const store = {
    subscribe(listener) {
        listeners.add(listener);
        listener({ ...state }); // Immediately notify with current state
        return () => listeners.delete(listener); // Return an unsubscribe function
    },

    getState() {
        return { ...state };
    },

    actions: {
        async initialize() {
            // Load last played video
            try {
                const savedLastVideo = localStorage.getItem(STORAGE_KEY_LAST_VIDEO);
                if (savedLastVideo) {
                    state.lastPlayedVideo = JSON.parse(savedLastVideo);
                }
            } catch (e) {
                console.error("Failed to load last played video", e);
                localStorage.removeItem(STORAGE_KEY_LAST_VIDEO);
            }
            
            // Load cached durations
            try {
                const savedDurations = localStorage.getItem(STORAGE_KEY_DURATIONS);
                if (savedDurations) {
                    cachedDurations = JSON.parse(savedDurations);
                }
            } catch (e) {
                console.error("Failed to load cached durations", e);
                localStorage.removeItem(STORAGE_KEY_DURATIONS);
            }

            await this.loadVideoList();
        },

        async loadVideoList() {
            state.isLoading = true;
            notify();
            try {
                // Fetch the list and immediately merge cached durations into it
                state.videoList = (await api.fetchVideos()).map(video => ({
                    ...video,
                    duration: cachedDurations[video.filename] || null
                }));
            } catch (e) {
                console.error("Failed to fetch videos", e);
                showToast("Could not load video list.", 'error');
            }
            state.isLoading = false;
            notify();
        },
        
        async fetchAndApplyDurations() {
            if (isFetchingDurations) {
                showToast('Already fetching durations.', 'info');
                return;
            }
            
            isFetchingDurations = true;
            showToast('Fetching video durations...', 'info', 5000);

            try {
                const newDurations = await api.fetchVideoDurations();
                // Merge new durations with existing cache, preferring new values
                cachedDurations = { ...cachedDurations, ...newDurations };
                localStorage.setItem(STORAGE_KEY_DURATIONS, JSON.stringify(cachedDurations));

                // Apply the newly merged durations to the current video list
                state.videoList.forEach(video => {
                    if (cachedDurations[video.filename]) {
                        video.duration = cachedDurations[video.filename];
                    }
                });
                showToast('Durations loaded successfully!', 'success');
            } catch (e) {
                console.error("Failed to fetch durations", e);
                showToast("Could not load video durations.", 'error');
            } finally {
                isFetchingDurations = false;
                notify(); // Re-render the list with the new data
            }
        },

        updateVideoDuration(filename, duration) {
            if (!filename || !duration || duration <= 0) return;
            
            const roundedDuration = Math.round(duration);

            // Update in-memory state for immediate UI consistency if needed
            const videoInList = state.videoList.find(v => v.filename === filename);
            if (videoInList) {
                videoInList.duration = roundedDuration;
            }

            // Update localStorage cache if the value is new or different
            if (cachedDurations[filename] !== roundedDuration) {
                cachedDurations[filename] = roundedDuration;
                localStorage.setItem(STORAGE_KEY_DURATIONS, JSON.stringify(cachedDurations));
            }
        },

        setFilter(newFilter) {
            state.filter = newFilter;
            notify();
        },

        playVideo(video, startTime = 0) {
            if (!video) return;
            state.currentVideo = video;
            state.currentVideoStartTime = startTime;
            state.lastPlayedVideo = video;
            state.segments = [];
            state.view = 'video';
            localStorage.setItem(STORAGE_KEY_LAST_VIDEO, JSON.stringify(video));
            notify();
        },

        showList() {
            state.currentVideo = null; // Clear current video when going back to list
            state.currentVideoStartTime = 0;
            state.view = 'list';
            notify();
        },

        addSegment(time) {
            if (!state.currentVideo || state.currentVideo.type !== 'original') return;
            state.segments.push(time);
            state.segments.sort((a, b) => a - b);
            notify();
        },

        removeLastSegment() {
            if (!state.currentVideo || state.currentVideo.type !== 'original' || state.segments.length === 0) return;
            state.segments.pop();
            notify();
        },

        deleteCurrentVideo() {
            if (!state.currentVideo || state.currentVideo.type !== 'original' || state.segments.length > 0) return;
            
            const videoToDelete = state.currentVideo;
            const originalList = [...state.videoList];
            const nextVideo = findNextVideoAfterChange(videoToDelete, originalList);

            // Optimistic UI update
            state.videoList = state.videoList.filter(v => !(v.filename === videoToDelete.filename && v.type === videoToDelete.type));
            
            if (nextVideo) {
                navigateToVideo(nextVideo);
            } else {
                location.hash = '#/';
            }
            
            // Fire and forget API call
            api.sendDeleteRequest(videoToDelete).catch(error => {
                console.error(`Background delete failed for ${videoToDelete.filename}:`, error);
                showToast(`Failed to delete ${videoToDelete.filename}`, 'error');
            });
        },

        createEditedVideo() {
            if (!state.currentVideo || state.currentVideo.type !== 'original' || state.segments.length === 0 || state.segments.length % 2 !== 0) return;

            const videoToEdit = state.currentVideo;
            const segmentsToSave = [...state.segments];
            const originalList = [...state.videoList];
            const nextVideo = findNextVideoAfterChange(videoToEdit, originalList);

            // Optimistic UI update
            state.videoList = state.videoList.filter(v => !(v.filename === videoToEdit.filename && v.type === videoToEdit.type));

            if (nextVideo) {
                navigateToVideo(nextVideo);
            } else {
                location.hash = '#/';
            }

            // Fire and forget API call
            api.sendEditRequest(videoToEdit, segmentsToSave).catch(error => {
                console.error(`Background edit failed for ${videoToEdit.filename}:`, error);
                showToast(`Failed to create edited version of ${videoToEdit.filename}.`, 'error');
            });
        }
    }
};