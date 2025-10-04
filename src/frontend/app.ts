// public/app.ts
import { DomElements } from "./types";
import { store } from "./modules/store";
import * as ui from "./modules/ui";
import * as player from "./modules/player";

let dom: DomElements;
let wakeLock: WakeLockSentinel | null = null;
let isScrubbing = false;
let lastScrollY = 0;

function handleScrub(e: PointerEvent) {
    if (isNaN(dom.videoPlayer.duration)) return;
    const rect = dom.progressBar.getBoundingClientRect();
    const position = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const newTime = dom.videoPlayer.duration * (position / rect.width);
    ui.updateProgressBar(newTime, dom.videoPlayer.duration);
    dom.timeDisplay.textContent = `${ui.formatTimePrecise(newTime)} ${ui.formatTimePrecise(dom.videoPlayer.duration)}`;
    dom.videoPlayer.currentTime = newTime;
}

function handleListViewScroll() {
    if (store.getState().view !== "list") return;
    const currentScrollY = window.scrollY;
    if (Math.abs(currentScrollY - lastScrollY) < 10) return;
    if (currentScrollY > lastScrollY && currentScrollY > 50) {
        dom.searchContainer.classList.add("search-container--hidden");
    } else {
        dom.searchContainer.classList.remove("search-container--hidden");
    }
    lastScrollY = currentScrollY < 0 ? 0 : currentScrollY;
}

function attachEventListeners() {
    dom.goBackBtn.addEventListener("click", () => store.actions.showList());

    dom.searchInput.addEventListener("input", (e) => {
        const newFilter = (e.target as HTMLInputElement).value;
        store.actions.setFilter(newFilter);
    });

    dom.clearSearchBtn.addEventListener("click", () => {
        store.actions.setFilter("");
        dom.searchInput.value = "";
        dom.searchInput.focus();
    });

    dom.getDurationsBtn.addEventListener("click", () => store.actions.fetchAndApplyDurations());

    dom.videoView.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest("#quadrantOverlay") || (e.target as HTMLElement).closest("#topBar")) {
            const { currentVideo, playerMode } = store.getState();
            if (!currentVideo) return;
            const isEditMode = playerMode === "edit" && currentVideo.type === "original";
            const finalOpacity = isEditMode ? "0.15" : "0";
            ui.flashTopBar(finalOpacity);
        }
    });

    dom.muteBtn.addEventListener("click", () => {
        dom.videoPlayer.muted = !dom.videoPlayer.muted;
        dom.muteBtn.textContent = dom.videoPlayer.muted ? "🔇" : "🔊";
    });

    dom.quadrantOverlay.addEventListener("pointerdown", (e) => {
        const action = (e.target as HTMLElement).dataset.action;
        const SEEK_TIME_SECONDS = 5;
        switch (action) {
            case "next":
                player.navigateVideoInList(1);
                break;
            case "prev":
                player.navigateVideoInList(-1);
                break;
            case "seek-forward":
                dom.videoPlayer.currentTime = Math.min(dom.videoPlayer.duration, dom.videoPlayer.currentTime + SEEK_TIME_SECONDS);
                break;
            case "seek-backward":
                dom.videoPlayer.currentTime = Math.max(0, dom.videoPlayer.currentTime - SEEK_TIME_SECONDS);
                dom.videoPlayer.play();
                break;
        }
    });
    dom.quadrantOverlay.addEventListener("contextmenu", (e) => e.preventDefault());

    dom.videoView.addEventListener("dblclick", (e) => e.preventDefault());
    dom.progressBar.addEventListener("dblclick", (e) => e.preventDefault());

    const onPointerMove = (e: PointerEvent) => {
        if (isScrubbing) handleScrub(e);
    };
    const onPointerUp = () => {
        if (isScrubbing) {
            isScrubbing = false;
            dom.videoPlayer.play();
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
        }
    };
    dom.progressBar.addEventListener("pointerdown", (e) => {
        isScrubbing = true;
        handleScrub(e as PointerEvent);
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
    });

    dom.addPointBtn.addEventListener("click", () => store.actions.addSegment(dom.videoPlayer.currentTime));

    dom.modeOrUndoBtn.addEventListener("click", () => {
        const { segments, playerMode, currentVideo } = store.getState();
        if (currentVideo?.type === "original" && playerMode === "edit" && segments.length > 0) {
            store.actions.removeLastSegment();
        } else {
            store.actions.togglePlayerMode();
        }
    });

    dom.videoOkBtn.addEventListener("click", () => store.actions.saveCurrentVideo());

    dom.deleteOrCutBtn.addEventListener("click", () => {
        const { segments } = store.getState();
        if (segments.length > 0) store.actions.createEditedVideo();
        else store.actions.deleteCurrentVideo();
    });

    dom.videoPlayer.addEventListener("timeupdate", handleTimeUpdate);
    dom.videoPlayer.addEventListener("loadedmetadata", () => {
        ui.render(store.getState());
        dom.muteBtn.textContent = dom.videoPlayer.muted ? "🔇" : "🔊";
        const { currentVideo } = store.getState();
        if (currentVideo) {
            store.actions.updateVideoDuration(currentVideo.filename, dom.videoPlayer.duration);
        }
    });

    window.addEventListener("scroll", handleListViewScroll);
}

function handleTimeUpdate() {
    if (dom.videoPlayer.seeking) return;
    const { currentTime, duration } = dom.videoPlayer;
    ui.updateProgressBar(currentTime, duration);
    dom.timeDisplay.textContent = `${ui.formatTimePrecise(currentTime)} ${ui.formatTimePrecise(duration)}`;
    const { currentVideo } = store.getState();
    if (currentVideo) {
        localStorage.setItem(player.STORAGE_KEY_PREFIX + currentVideo.filename, String(Math.round(currentTime)));
    }
}

async function requestWakeLock() {
    if ("wakeLock" in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request("screen");
        } catch (err) {
            console.error("Could not acquire Wake Lock:", err);
        }
    }
}

async function releaseWakeLock() {
    if (wakeLock) {
        await wakeLock.release();
        wakeLock = null;
    }
}

function initialize() {
    dom = {
        listView: document.getElementById("listView") as HTMLElement,
        videoView: document.getElementById("videoView") as HTMLElement,
        listContainer: document.getElementById("listContainer") as HTMLElement,
        videoItemsWrapper: document.getElementById("videoItemsWrapper") as HTMLElement,
        searchContainer: document.getElementById("searchContainer") as HTMLElement,
        videoPlayer: document.getElementById("videoPlayer") as HTMLVideoElement,
        streamerNameEl: document.getElementById("streamerName") as HTMLElement,
        searchInput: document.getElementById("searchInput") as HTMLInputElement,
        clearSearchBtn: document.getElementById("clearSearchBtn") as HTMLButtonElement,
        getDurationsBtn: document.getElementById("getDurationsBtn") as HTMLButtonElement,
        quadrantOverlay: document.getElementById("quadrantOverlay") as HTMLElement,
        topBar: document.getElementById("topBar") as HTMLElement,
        progressBar: document.getElementById("progressBar") as HTMLElement,
        progressFill: document.getElementById("progressFill") as HTMLElement,
        playerControlsContainer: document.getElementById("playerControlsContainer") as HTMLElement,
        muteBtn: document.getElementById("muteBtn") as HTMLButtonElement,
        addPointBtn: document.getElementById("addPointBtn") as HTMLButtonElement,
        timeDisplay: document.getElementById("timeDisplay") as HTMLElement,
        goBackBtn: document.getElementById("goBackBtn") as HTMLButtonElement,
        modeOrUndoBtn: document.getElementById("modeOrUndoBtn") as HTMLButtonElement,
        videoOkBtn: document.getElementById("videoOkBtn") as HTMLButtonElement,
        deleteOrCutBtn: document.getElementById("deleteOrCutBtn") as HTMLButtonElement,
    };

    ui.initUI(dom);
    player.initPlayer(dom);

    let lastPlayedVideoSrc: string | null = null;
    store.subscribe((state) => {
        ui.render(state);
        const currentSrc = state.currentVideo ? `/video/${state.currentVideo.type}/${encodeURIComponent(state.currentVideo.filename)}` : null;
        if (lastPlayedVideoSrc !== currentSrc) {
            lastPlayedVideoSrc = currentSrc;
            if (state.currentVideo) {
                player.playVideo(state.currentVideo, state.currentVideoStartTime);
                requestWakeLock();
            } else {
                player.stopPlayback();
                releaseWakeLock();
                dom.searchContainer.classList.remove("search-container--hidden");
                lastScrollY = 0;
            }
        }
    });

    attachEventListeners();
    store.actions.initialize();
}

document.addEventListener("DOMContentLoaded", initialize);
