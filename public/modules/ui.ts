// public/modules/ui.ts
import { AppState, DomElements } from "../types";
import { navigateToVideo } from "./player";

let dom: Partial<DomElements> = {};
// Use ReturnType<typeof setTimeout> for perfect type inference in any environment.
let topBarFadeTimer: ReturnType<typeof setTimeout> | null = null;

export function initUI(domElements: DomElements): void {
    dom = domElements;
}

export function flashTopBar(finalOpacity: string | number): void {
    if (!dom.topBar) return;
    if (topBarFadeTimer) {
        clearTimeout(topBarFadeTimer);
        dom.topBar.style.transition = "";
    }
    dom.topBar.style.transition = "none";
    dom.topBar.style.opacity = "0.5";
    void dom.topBar.offsetHeight;
    dom.topBar.style.transition = "opacity 1s ease";
    dom.topBar.style.opacity = String(finalOpacity);
    topBarFadeTimer = setTimeout(() => {
        if (dom.topBar) dom.topBar.style.transition = "";
        topBarFadeTimer = null;
    }, 1000);
}

export function formatDuration(seconds: number | null): string {
    if (seconds === null || isNaN(seconds) || seconds < 0) return "--:--";
    const totalSecondsInt = Math.floor(seconds);
    const h = Math.floor(totalSecondsInt / 3600);
    const m = Math.floor((totalSecondsInt % 3600) / 60)
        .toString()
        .padStart(2, "0");
    const s = (totalSecondsInt % 60).toString().padStart(2, "0");
    if (h > 0) return `${h}:${m}:${s}`;
    return `${m}:${s}`;
}

export function formatTimePrecise(seconds: number): string {
    if (isNaN(seconds)) return "00:00.000";
    const ms = Math.floor((seconds % 1) * 1000)
        .toString()
        .padStart(3, "0");
    const totalSecondsInt = Math.floor(seconds);
    const h = Math.floor(totalSecondsInt / 3600)
        .toString()
        .padStart(2, "0");
    const m = Math.floor((totalSecondsInt % 3600) / 60)
        .toString()
        .padStart(2, "0");
    const s = (totalSecondsInt % 60).toString().padStart(2, "0");
    const timeWithoutHours = `${m}:${s}.${ms}`;
    const timeWithHours = `${h}:${m}:${s}.${ms}`;
    return totalSecondsInt >= 3600 ? timeWithHours : timeWithoutHours;
}

export function showToast(message: string, type: "info" | "success" | "error" = "info", duration = 3000): void {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add("show"), 10);
    setTimeout(() => {
        toast.classList.remove("show");
        toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    }, duration);
}

function renderVideoList(state: AppState) {
    if (!dom.videoItemsWrapper) return;
    dom.videoItemsWrapper.innerHTML = "";
    const regex = state.filter ? new RegExp(state.filter, "i") : null;
    const filteredList = state.videoList.filter((video) => !regex || regex.test(video.filename));

    if (state.isLoading) {
        dom.videoItemsWrapper.innerHTML = '<p id="loadingMessage">Loading...</p>';
        return;
    }

    if (filteredList.length === 0) {
        dom.videoItemsWrapper.innerHTML = '<p class="info-message">No videos found.</p>';
        return;
    }

    const activeVideo = state.currentVideo || state.lastPlayedVideo;
    filteredList.forEach((video) => {
        const item = document.createElement("div");
        item.className = "list-item video-item";
        item.addEventListener("click", () => navigateToVideo(video));
        const nameSpan = document.createElement("span");
        nameSpan.className = "list-item-name";
        nameSpan.textContent = video.filename + (video.type === "edited" ? " (edited)" : "");
        const durationSpan = document.createElement("span");
        durationSpan.className = "list-item-duration";
        durationSpan.textContent = formatDuration(video.duration);
        item.appendChild(nameSpan);
        item.appendChild(durationSpan);
        if (activeVideo && video.filename === activeVideo.filename && video.type === activeVideo.type) {
            item.classList.add("current-video");
        }
        dom.videoItemsWrapper?.appendChild(item);
    });

    const currentItem = dom.videoItemsWrapper.querySelector(".current-video");
    if (currentItem) currentItem.scrollIntoView({ block: "center", behavior: "auto" });
}

function renderPlayer(state: AppState) {
    const { currentVideo, segments, playerMode } = state;

    // --- ARCHITECTURAL DECISION: Type Safety & Readability ---
    // Why: By destructuring the potentially undefined properties of the module-level `dom`
    // object into local constants, we provide a clear signal to both TypeScript and
    // other developers. The single `if` check below becomes a definitive type guard.
    // This resolves the "possibly 'undefined'" error because TypeScript's control
    // flow analysis can confidently track the state of local constants, whereas it
    // can be less certain about properties on a mutable, shared object.
    const {
        quadrantOverlay,
        progressBar,
        playerControlsContainer,
        topBar,
        streamerNameEl,
        modeOrUndoBtn,
        goBackBtn,
        addPointBtn,
        deleteOrCutBtn,
        videoOkBtn,
        muteBtn,
        videoPlayer,
    } = dom;

    if (
        !quadrantOverlay ||
        !progressBar ||
        !playerControlsContainer ||
        !topBar ||
        !streamerNameEl ||
        !modeOrUndoBtn ||
        !goBackBtn ||
        !addPointBtn ||
        !deleteOrCutBtn ||
        !videoOkBtn ||
        !muteBtn ||
        !videoPlayer
    ) {
        // Why: This is a defensive guard clause. If any of the essential DOM elements
        // aren't found when the app initializes, we immediately exit this render function.
        // This prevents a cascade of runtime errors and keeps the UI in a stable state.
        return;
    }

    // From this point on, we use the local constants (e.g., `videoPlayer`), which
    // are guaranteed to be defined, making the rest of the function type-safe.
    quadrantOverlay.classList.toggle("hidden", !currentVideo);
    progressBar.classList.toggle("hidden", !currentVideo);
    playerControlsContainer.classList.toggle("hidden", !currentVideo);
    document.getElementById("timeDisplayContainer")?.classList.toggle("hidden", !currentVideo);

    if (currentVideo) {
        streamerNameEl.textContent = `${currentVideo.filename}`;
        const isOriginal = currentVideo.type === "original";
        const hasSegments = segments.length > 0;
        const isEditMode = playerMode === "edit" && isOriginal;
        topBar.style.opacity = isEditMode ? "0.15" : "0";

        [modeOrUndoBtn, goBackBtn, addPointBtn, deleteOrCutBtn, videoOkBtn, muteBtn].forEach((btn) => btn.classList.add("hidden"));

        if (playerMode === "view" || !isOriginal) {
            muteBtn.classList.remove("hidden");
            goBackBtn.classList.remove("hidden");
            if (isOriginal) {
                modeOrUndoBtn.classList.remove("hidden");
                modeOrUndoBtn.textContent = "✏️";
                modeOrUndoBtn.title = "Edit Mode";
            }
        } else {
            addPointBtn.classList.remove("hidden");
            if (hasSegments) {
                modeOrUndoBtn.classList.remove("hidden");
                modeOrUndoBtn.textContent = "↪️";
                modeOrUndoBtn.title = "Undo Last Point";
                deleteOrCutBtn.classList.remove("hidden");
                deleteOrCutBtn.textContent = "✂️";
                deleteOrCutBtn.title = "Create Cut";
                deleteOrCutBtn.disabled = segments.length % 2 !== 0;
            } else {
                modeOrUndoBtn.classList.remove("hidden");
                modeOrUndoBtn.textContent = "👁️";
                modeOrUndoBtn.title = "View Mode";
                videoOkBtn.classList.remove("hidden");
                deleteOrCutBtn.classList.remove("hidden");
                deleteOrCutBtn.textContent = "🗑️";
                deleteOrCutBtn.title = "Delete Video";
                deleteOrCutBtn.disabled = false;
            }
        }
    }

    document.querySelectorAll(".segment-marker").forEach((m) => m.remove());
    const segmentContainer = document.getElementById("segmentTextContainer");
    if (segmentContainer) segmentContainer.innerHTML = "";

    if (currentVideo && !isNaN(videoPlayer.duration) && segmentContainer) {
        segments.forEach((point) => {
            const marker = document.createElement("div");
            marker.className = "segment-marker";
            const percentage = (point / videoPlayer.duration) * 100;
            marker.style.left = `${percentage}%`;
            progressBar.appendChild(marker);
        });
        for (let i = 0; i < segments.length; i += 2) {
            const row = document.createElement("div");
            row.className = "segment-row";
            const startSpan = document.createElement("span");
            startSpan.className = "segment-time-start";
            startSpan.textContent = `start: ${formatTimePrecise(segments[i])}`;
            row.appendChild(startSpan);
            if (segments[i + 1] !== undefined) {
                const endSpan = document.createElement("span");
                endSpan.className = "segment-time-end";
                endSpan.textContent = `end: ${formatTimePrecise(segments[i + 1])}`;
                row.appendChild(endSpan);
            }
            segmentContainer.appendChild(row);
        }
    }
}

export function updateProgressBar(currentTime: number, duration: number): void {
    if (!dom.progressFill || isNaN(duration)) return;
    const percentage = (currentTime / duration) * 100;
    dom.progressFill.style.width = `${percentage}%`;
}

export function render(state: AppState): void {
    if (!dom.videoView || !dom.searchInput || !dom.clearSearchBtn) return;
    dom.videoView.classList.toggle("active-view", state.view === "video");
    if (document.activeElement !== dom.searchInput) {
        dom.searchInput.value = state.filter;
    }
    dom.clearSearchBtn.classList.toggle("hidden", !state.filter);
    if (state.view === "list") {
        renderVideoList(state);
    } else if (state.view === "video") {
        renderPlayer(state);
    }
}
