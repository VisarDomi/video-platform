// src/frontend/modules/store.ts
import { AppState, Video } from "../types";
import * as api from "./api";
import { UI } from "./ui";

const STORAGE_KEY_LAST_VIDEO = "last-played-video";
const STORAGE_KEY_DURATIONS = "video-durations";

export class Store {
    private state: AppState = {
        view: "list",
        isLoading: true,
        videoList: [],
        filter: "",
        currentVideo: null,
        currentVideoStartTime: 0,
        lastPlayedVideo: null,
        segments: [],
        playerMode: "view",
    };
    private isFetchingDurations = false;
    private cachedDurations: Record<string, number> = {};
    private listeners = new Set<(state: AppState) => void>();

    private notify(): void {
        this.listeners.forEach((listener) => listener({ ...this.state }));
    }

    private findNextVideoAfterChange(videoToChange: Video, originalList: Video[]): Video | null {
        const { filter } = this.state;
        const regex = filter ? new RegExp(filter, "i") : null;
        const currentFilteredList = originalList.filter((video) => !regex || regex.test(video.filename));
        const currentIndex = currentFilteredList.findIndex((v) => v.filename === videoToChange.filename && v.type === videoToChange.type);

        const newList = this.state.videoList.filter((v) => !(v.filename === videoToChange.filename && v.type === videoToChange.type));
        const newFilteredList = newList.filter((video) => !regex || regex.test(video.filename));

        if (newFilteredList.length === 0) {
            return null;
        }
        const nextIndex = Math.min(currentIndex, newFilteredList.length - 1);
        return newFilteredList[nextIndex];
    }

    public subscribe(listener: (state: AppState) => void): () => void {
        this.listeners.add(listener);
        listener({ ...this.state }); // Immediately notify with current state
        return () => this.listeners.delete(listener); // Return an unsubscribe function
    }

    public getState(): AppState {
        return { ...this.state };
    }

    // --- Actions as Public Methods ---

    public async initialize(): Promise<void> {
        try {
            const savedLastVideo = localStorage.getItem(STORAGE_KEY_LAST_VIDEO);
            if (savedLastVideo) this.state.lastPlayedVideo = JSON.parse(savedLastVideo);
        } catch (e) {
            console.error("Failed to load last played video", e);
            localStorage.removeItem(STORAGE_KEY_LAST_VIDEO);
        }

        try {
            const savedDurations = localStorage.getItem(STORAGE_KEY_DURATIONS);
            if (savedDurations) this.cachedDurations = JSON.parse(savedDurations);
        } catch (e) {
            console.error("Failed to load cached durations", e);
            localStorage.removeItem(STORAGE_KEY_DURATIONS);
        }

        await this.loadVideoList();
    }

    public async loadVideoList(): Promise<void> {
        this.state.isLoading = true;
        this.notify();
        try {
            const videos = await api.fetchVideos();
            this.state.videoList = videos.map((video) => ({
                ...video,
                duration: this.cachedDurations[video.filename] || null,
            }));
        } catch (e) {
            console.error("Failed to fetch videos", e);
            UI.showToast(`ERROR: Could not load video list.`, "error", 8000);
        }
        this.state.isLoading = false;
        this.notify();
    }

    public async fetchAndApplyDurations(): Promise<void> {
        if (this.isFetchingDurations) {
            UI.showToast("Already fetching durations.", "info");
            return;
        }
        this.isFetchingDurations = true;
        UI.showToast("Fetching video durations...", "info", 5000);
        try {
            const newDurations = await api.fetchVideoDurations();
            this.cachedDurations = { ...this.cachedDurations, ...newDurations };
            localStorage.setItem(STORAGE_KEY_DURATIONS, JSON.stringify(this.cachedDurations));
            this.state.videoList.forEach((video) => {
                if (this.cachedDurations[video.filename]) {
                    video.duration = this.cachedDurations[video.filename];
                }
            });
            UI.showToast("Durations loaded successfully!", "success");
        } catch (e) {
            console.error("Failed to fetch durations", e);
            UI.showToast("Could not load video durations.", "error");
        } finally {
            this.isFetchingDurations = false;
            this.notify();
        }
    }

    public updateVideoDuration(filename: string, duration: number): void {
        if (!filename || !duration || duration <= 0) return;
        const roundedDuration = Math.round(duration);
        const videoInList = this.state.videoList.find((v) => v.filename === filename);
        if (videoInList) videoInList.duration = roundedDuration;
        if (this.cachedDurations[filename] !== roundedDuration) {
            this.cachedDurations[filename] = roundedDuration;
            localStorage.setItem(STORAGE_KEY_DURATIONS, JSON.stringify(this.cachedDurations));
        }
    }

    public setFilter(newFilter: string): void {
        this.state.filter = newFilter;
        this.notify();
    }

    public playVideo(video: Video, startTime = 0): void {
        if (!video) return;
        this.state.currentVideo = video;
        this.state.currentVideoStartTime = startTime;
        this.state.lastPlayedVideo = video;
        this.state.segments = [];
        this.state.view = "video";
        this.state.playerMode = video.type === "original" ? "edit" : "view";
        localStorage.setItem(STORAGE_KEY_LAST_VIDEO, JSON.stringify(video));
        this.notify();
    }

    public showList(): void {
        this.state.currentVideo = null;
        this.state.currentVideoStartTime = 0;
        this.state.view = "list";
        this.notify();
    }

    public togglePlayerMode(): void {
        if (this.state.currentVideo?.type !== "original") return;
        this.state.playerMode = this.state.playerMode === "edit" ? "view" : "edit";
        this.notify();
    }

    public addSegment(time: number): void {
        if (!this.state.currentVideo || this.state.currentVideo.type !== "original") return;
        this.state.segments.push(time);
        this.state.segments.sort((a, b) => a - b);
        this.notify();
    }

    public removeLastSegment(): void {
        if (!this.state.currentVideo || this.state.currentVideo.type !== "original" || this.state.segments.length === 0) return;
        this.state.segments.pop();
        this.notify();
    }

    public deleteCurrentVideo(): void {
        if (!this.state.currentVideo || this.state.currentVideo.type !== "original" || this.state.segments.length > 0) return;
        const videoToDelete = this.state.currentVideo;
        const originalList = [...this.state.videoList];

        this.state.videoList = this.state.videoList.filter((v) => !(v.filename === videoToDelete.filename && v.type === videoToDelete.type));
        const nextVideo = this.findNextVideoAfterChange(videoToDelete, originalList);

        if (nextVideo) {
            this.playVideo(nextVideo, 0); // This will set the new state and notify
        } else {
            this.showList(); // No more videos, go back to list and notify
        }

        api.sendDeleteRequest(videoToDelete).catch((error) => {
            console.error(`Background delete failed for ${videoToDelete.filename}:`, error);
            UI.showToast(`Failed to delete ${videoToDelete.filename}`, "error");
        });
    }

    public saveCurrentVideo(): void {
        if (!this.state.currentVideo || this.state.currentVideo.type !== "original" || this.state.segments.length > 0) return;
        const videoToSave = this.state.currentVideo;
        const originalList = [...this.state.videoList];
        this.state.videoList = this.state.videoList.filter((v) => !(v.filename === videoToSave.filename && v.type === videoToSave.type));
        const nextVideo = this.findNextVideoAfterChange(videoToSave, originalList);

        if (nextVideo) {
            this.playVideo(nextVideo, 0);
        } else {
            this.showList();
        }

        api.sendSaveRequest(videoToSave).catch((error) => {
            console.error(`Background save failed for ${videoToSave.filename}:`, error);
            UI.showToast(`Failed to save ${videoToSave.filename}`, "error");
        });
    }

    public createEditedVideo(): void {
        if (!this.state.currentVideo || this.state.currentVideo.type !== "original" || this.state.segments.length === 0 || this.state.segments.length % 2 !== 0)
            return;
        const videoToEdit = this.state.currentVideo;
        const segmentsToSave = [...this.state.segments];
        const originalList = [...this.state.videoList];

        this.state.videoList = this.state.videoList.filter((v) => !(v.filename === videoToEdit.filename && v.type === videoToEdit.type));
        const nextVideo = this.findNextVideoAfterChange(videoToEdit, originalList);

        if (nextVideo) {
            this.playVideo(nextVideo, 0);
        } else {
            this.showList();
        }

        api.sendEditRequest(videoToEdit, segmentsToSave).catch((error) => {
            console.error(`Background edit failed for ${videoToEdit.filename}:`, error);
            UI.showToast(`Failed to create edited version of ${videoToEdit.filename}.`, "error");
        });
    }
}
