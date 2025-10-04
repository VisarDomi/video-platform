// public/modules/store.ts
import { AppState, Video } from "../types";
import * as api from "./api";
import { navigateToVideo } from "./player";
import { showToast } from "./ui";

const STORAGE_KEY_LAST_VIDEO = "last-played-video";
const STORAGE_KEY_DURATIONS = "video-durations";

// --- Private State ---
let state: AppState = {
    view: "list", // 'list' or 'video'
    isLoading: true,
    videoList: [],
    filter: "",
    currentVideo: null,
    currentVideoStartTime: 0,
    lastPlayedVideo: null,
    segments: [],
    playerMode: "view", // 'view' or 'edit'
};
let isFetchingDurations = false;
let cachedDurations: Record<string, number> = {};

// --- Listener Pattern ---
const listeners = new Set<(state: AppState) => void>();
function notify() {
    listeners.forEach((listener) => listener({ ...state }));
}

// --- Internal Logic ---
function findNextVideoAfterChange(videoToChange: Video, originalList: Video[]): Video | null {
    const filter = state.filter;
    const regex = filter ? new RegExp(filter, "i") : null;
    const currentFilteredList = originalList.filter((video) => !regex || regex.test(video.filename));
    const currentIndex = currentFilteredList.findIndex((v) => v.filename === videoToChange.filename && v.type === videoToChange.type);

    const newList = state.videoList.filter((v) => !(v.filename === videoToChange.filename && v.type === videoToChange.type));
    const newFilteredList = newList.filter((video) => !regex || regex.test(video.filename));

    if (newFilteredList.length === 0) {
        return null;
    }
    const nextIndex = Math.min(currentIndex, newFilteredList.length - 1);
    return newFilteredList[nextIndex];
}

// --- Public API (Actions & Getters) ---
export const store = {
    subscribe(listener: (state: AppState) => void): () => void {
        listeners.add(listener);
        listener({ ...state }); // Immediately notify with current state
        return () => listeners.delete(listener); // Return an unsubscribe function
    },

    getState(): AppState {
        return { ...state };
    },

    actions: {
        async initialize(): Promise<void> {
            showToast("DEBUG: App initializing...", "info"); // DEBUG: Confirm app start
            try {
                const savedLastVideo = localStorage.getItem(STORAGE_KEY_LAST_VIDEO);
                if (savedLastVideo) state.lastPlayedVideo = JSON.parse(savedLastVideo);
            } catch (e) {
                console.error("Failed to load last played video", e);
                localStorage.removeItem(STORAGE_KEY_LAST_VIDEO);
            }

            try {
                const savedDurations = localStorage.getItem(STORAGE_KEY_DURATIONS);
                if (savedDurations) cachedDurations = JSON.parse(savedDurations);
            } catch (e) {
                console.error("Failed to load cached durations", e);
                localStorage.removeItem(STORAGE_KEY_DURATIONS);
            }

            await this.loadVideoList();
        },

        async loadVideoList(): Promise<void> {
            state.isLoading = true;
            notify();
            showToast("DEBUG: Fetching video list...", "info"); // DEBUG: Announce fetch start
            try {
                const videos = await api.fetchVideos();
                showToast(`DEBUG: Loaded ${videos.length} videos.`, "success", 5000); // DEBUG: Show success and count
                state.videoList = videos.map((video) => ({
                    ...video,
                    duration: cachedDurations[video.filename] || null,
                }));
            } catch (e) {
                console.error("Failed to fetch videos", e);
                showToast(`ERROR: Could not load video list.`, "error", 8000); // DEBUG: Show fetch error
            }
            state.isLoading = false;
            notify();
        },

        async fetchAndApplyDurations(): Promise<void> {
            if (isFetchingDurations) {
                showToast("Already fetching durations.", "info");
                return;
            }
            isFetchingDurations = true;
            showToast("Fetching video durations...", "info", 5000);
            try {
                const newDurations = await api.fetchVideoDurations();
                cachedDurations = { ...cachedDurations, ...newDurations };
                localStorage.setItem(STORAGE_KEY_DURATIONS, JSON.stringify(cachedDurations));
                state.videoList.forEach((video) => {
                    if (cachedDurations[video.filename]) {
                        video.duration = cachedDurations[video.filename];
                    }
                });
                showToast("Durations loaded successfully!", "success");
            } catch (e) {
                console.error("Failed to fetch durations", e);
                showToast("Could not load video durations.", "error");
            } finally {
                isFetchingDurations = false;
                notify();
            }
        },

        updateVideoDuration(filename: string, duration: number): void {
            if (!filename || !duration || duration <= 0) return;
            const roundedDuration = Math.round(duration);
            const videoInList = state.videoList.find((v) => v.filename === filename);
            if (videoInList) videoInList.duration = roundedDuration;
            if (cachedDurations[filename] !== roundedDuration) {
                cachedDurations[filename] = roundedDuration;
                localStorage.setItem(STORAGE_KEY_DURATIONS, JSON.stringify(cachedDurations));
            }
        },

        setFilter(newFilter: string): void {
            state.filter = newFilter;
            notify();
        },

        playVideo(video: Video, startTime = 0): void {
            if (!video) return;
            state.currentVideo = video;
            state.currentVideoStartTime = startTime;
            state.lastPlayedVideo = video;
            state.segments = [];
            state.view = "video";
            state.playerMode = video.type === "original" ? "edit" : "view";
            localStorage.setItem(STORAGE_KEY_LAST_VIDEO, JSON.stringify(video));
            notify();
        },

        showList(): void {
            state.currentVideo = null;
            state.currentVideoStartTime = 0;
            state.view = "list";
            notify();
        },

        togglePlayerMode(): void {
            if (state.currentVideo?.type !== "original") return;
            state.playerMode = state.playerMode === "edit" ? "view" : "edit";
            notify();
        },

        addSegment(time: number): void {
            if (!state.currentVideo || state.currentVideo.type !== "original") return;
            state.segments.push(time);
            state.segments.sort((a, b) => a - b);
            notify();
        },

        removeLastSegment(): void {
            if (!state.currentVideo || state.currentVideo.type !== "original" || state.segments.length === 0) return;
            state.segments.pop();
            notify();
        },

        deleteCurrentVideo(): void {
            if (!state.currentVideo || state.currentVideo.type !== "original" || state.segments.length > 0) return;
            const videoToDelete = state.currentVideo;
            const originalList = [...state.videoList];
            const nextVideo = findNextVideoAfterChange(videoToDelete, originalList);
            state.videoList = state.videoList.filter((v) => !(v.filename === videoToDelete.filename && v.type === videoToDelete.type));
            if (nextVideo) navigateToVideo(nextVideo);
            else this.showList();
            api.sendDeleteRequest(videoToDelete).catch((error) => {
                console.error(`Background delete failed for ${videoToDelete.filename}:`, error);
                showToast(`Failed to delete ${videoToDelete.filename}`, "error");
            });
        },

        saveCurrentVideo(): void {
            if (!state.currentVideo || state.currentVideo.type !== "original" || state.segments.length > 0) return;
            const videoToSave = state.currentVideo;
            const originalList = [...state.videoList];
            const nextVideo = findNextVideoAfterChange(videoToSave, originalList);
            state.videoList = state.videoList.filter((v) => !(v.filename === videoToSave.filename && v.type === videoToSave.type));
            if (nextVideo) navigateToVideo(nextVideo);
            else this.showList();
            api.sendSaveRequest(videoToSave).catch((error) => {
                console.error(`Background save failed for ${videoToSave.filename}:`, error);
                showToast(`Failed to save ${videoToSave.filename}`, "error");
            });
        },

        createEditedVideo(): void {
            if (!state.currentVideo || state.currentVideo.type !== "original" || state.segments.length === 0 || state.segments.length % 2 !== 0) return;
            const videoToEdit = state.currentVideo;
            const segmentsToSave = [...state.segments];
            const originalList = [...state.videoList];
            const nextVideo = findNextVideoAfterChange(videoToEdit, originalList);
            state.videoList = state.videoList.filter((v) => !(v.filename === videoToEdit.filename && v.type === videoToEdit.type));
            if (nextVideo) navigateToVideo(nextVideo);
            else this.showList();
            api.sendEditRequest(videoToEdit, segmentsToSave).catch((error) => {
                console.error(`Background edit failed for ${videoToEdit.filename}:`, error);
                showToast(`Failed to create edited version of ${videoToEdit.filename}.`, "error");
            });
        },
    },
};
