// public/modules/store.js
import * as api from './api.js';
import { navigateToVideo } from './player.js';

const STORAGE_KEY_LAST_VIDEO = 'last-played-video';

// --- Private State ---
let state = {
    view: 'list', // 'list' or 'video'
    isLoading: true,
    videoList: [],
    filter: '',
    currentVideo: null,
    lastPlayedVideo: null,
    segments: [],
};

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
            try {
                const savedLastVideo = localStorage.getItem(STORAGE_KEY_LAST_VIDEO);
                if (savedLastVideo) {
                    state.lastPlayedVideo = JSON.parse(savedLastVideo);
                }
            } catch (e) {
                console.error("Failed to load last played video", e);
                localStorage.removeItem(STORAGE_KEY_LAST_VIDEO);
            }
            await this.loadVideoList();
        },

        async loadVideoList() {
            state.isLoading = true;
            notify();
            try {
                state.videoList = await api.fetchVideos();
            } catch (e) {
                console.error("Failed to fetch videos", e);
                alert("Could not load video list. Please check the server connection.");
            }
            state.isLoading = false;
            notify();
        },
        
        setFilter(newFilter) {
            state.filter = newFilter;
            notify();
        },

        playVideo(video, startTime = 0) {
            if (!video) return;
            state.currentVideo = video;
            state.lastPlayedVideo = video;
            state.segments = [];
            state.view = 'video';
            localStorage.setItem(STORAGE_KEY_LAST_VIDEO, JSON.stringify(video));
            notify();
        },

        showList() {
            state.currentVideo = null; // Clear current video when going back to list
            state.view = 'list';
            notify();
        },

        addSegment(time) {
            if (!state.currentVideo || state.currentVideo.type !== 'original') return;
            state.segments.push(time);
            state.segments.sort((a, b) => a - b);
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
                alert(`Failed to delete ${videoToDelete.filename} on the server. The list may be out of sync. Please refresh.`);
                // Revert state on failure if desired, but for this app an alert is sufficient.
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
                alert(`Failed to create edited version of ${videoToEdit.filename}. The list may be out of sync. Please refresh.`);
            });
        }
    }
};