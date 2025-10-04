// src/frontend/app.ts
import { DomElements, Video } from "./types";
import { Store } from "./modules/store";
import { UI } from "./modules/ui";
import { Player, STORAGE_KEY_PREFIX } from "./modules/player";

class App {
    private dom!: DomElements;
    private store!: Store;
    private ui!: UI;
    private player!: Player;

    private wakeLock: WakeLockSentinel | null = null;
    private isScrubbing = false;
    private lastScrollY = 0;
    private lastPlayedVideoSrc: string | null = null;

    public init() {
        this.dom = {
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

        this.store = new Store();
        this.ui = new UI(this.dom);
        this.player = new Player(this.dom, this.store);

        this.store.subscribe((state) => {
            this.ui.render(state);
            const currentSrc = state.currentVideo ? `/video/${state.currentVideo.type}/${encodeURIComponent(state.currentVideo.filename)}` : null;

            if (this.lastPlayedVideoSrc !== currentSrc) {
                this.lastPlayedVideoSrc = currentSrc;
                if (state.currentVideo) {
                    this.player.playVideo(state.currentVideo, state.currentVideoStartTime);
                    this.requestWakeLock();
                } else {
                    this.player.stopPlayback();
                    this.releaseWakeLock();
                    this.dom.searchContainer.classList.remove("search-container--hidden");
                    this.lastScrollY = 0;
                }
            }
        });

        this.attachEventListeners();
        this.store.initialize();
    }

    private handleScrub(e: PointerEvent) {
        if (isNaN(this.dom.videoPlayer.duration)) return;
        const rect = this.dom.progressBar.getBoundingClientRect();
        const position = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const newTime = this.dom.videoPlayer.duration * (position / rect.width);
        this.ui.updateProgressBar(newTime, this.dom.videoPlayer.duration);
        this.dom.timeDisplay.textContent = `${this.ui.formatTimePrecise(newTime)} ${this.ui.formatTimePrecise(this.dom.videoPlayer.duration)}`;
        this.dom.videoPlayer.currentTime = newTime;
    }

    private handleTimeUpdate() {
        if (this.dom.videoPlayer.seeking) return;
        const { currentTime, duration } = this.dom.videoPlayer;
        this.ui.updateProgressBar(currentTime, duration);
        this.dom.timeDisplay.textContent = `${this.ui.formatTimePrecise(currentTime)} ${this.ui.formatTimePrecise(duration)}`;
        const { currentVideo } = this.store.getState();
        if (currentVideo) {
            localStorage.setItem(STORAGE_KEY_PREFIX + currentVideo.filename, String(Math.round(currentTime)));
        }
    }

    private handleListViewScroll() {
        if (this.store.getState().view !== "list") return;
        const currentScrollY = window.scrollY;
        if (Math.abs(currentScrollY - this.lastScrollY) < 10) return;
        if (currentScrollY > this.lastScrollY && currentScrollY > 50) {
            this.dom.searchContainer.classList.add("search-container--hidden");
        } else {
            this.dom.searchContainer.classList.remove("search-container--hidden");
        }
        this.lastScrollY = currentScrollY < 0 ? 0 : currentScrollY;
    }

    private attachEventListeners() {
        // Video List Item Clicks (Event Delegation)
        this.dom.videoItemsWrapper.addEventListener("click", (e) => {
            const item = (e.target as HTMLElement).closest<HTMLElement>(".video-item");
            if (item?.dataset.filename && item.dataset.type) {
                this.player.navigateToVideo({
                    filename: item.dataset.filename,
                    type: item.dataset.type as Video["type"],
                    duration: null, // Not needed for navigation
                });
            }
        });

        this.dom.goBackBtn.addEventListener("click", () => this.store.showList());
        this.dom.searchInput.addEventListener("input", (e) => this.store.setFilter((e.target as HTMLInputElement).value));
        this.dom.clearSearchBtn.addEventListener("click", () => {
            this.store.setFilter("");
            this.dom.searchInput.value = "";
            this.dom.searchInput.focus();
        });
        this.dom.getDurationsBtn.addEventListener("click", () => this.store.fetchAndApplyDurations());
        this.dom.videoView.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest("#quadrantOverlay") || (e.target as HTMLElement).closest("#topBar")) {
                const { currentVideo, playerMode } = this.store.getState();
                if (!currentVideo) return;
                const isEditMode = playerMode === "edit" && currentVideo.type === "original";
                const finalOpacity = isEditMode ? "0.15" : "0";
                this.ui.flashTopBar(finalOpacity);
            }
        });
        this.dom.muteBtn.addEventListener("click", () => {
            this.dom.videoPlayer.muted = !this.dom.videoPlayer.muted;
            this.dom.muteBtn.textContent = this.dom.videoPlayer.muted ? "🔇" : "🔊";
        });
        this.dom.quadrantOverlay.addEventListener("pointerdown", (e) => {
            const action = (e.target as HTMLElement).dataset.action;
            switch (action) {
                case "next":
                    this.player.navigateVideoInList(1);
                    break;
                case "prev":
                    this.player.navigateVideoInList(-1);
                    break;
                case "seek-forward":
                    this.dom.videoPlayer.currentTime = Math.min(this.dom.videoPlayer.duration, this.dom.videoPlayer.currentTime + 5);
                    break;
                case "seek-backward":
                    this.dom.videoPlayer.currentTime = Math.max(0, this.dom.videoPlayer.currentTime - 5);
                    this.dom.videoPlayer.play();
                    break;
            }
        });
        this.dom.quadrantOverlay.addEventListener("contextmenu", (e) => e.preventDefault());
        this.dom.videoView.addEventListener("dblclick", (e) => e.preventDefault());
        this.dom.progressBar.addEventListener("dblclick", (e) => e.preventDefault());

        const onPointerMove = (e: PointerEvent) => {
            if (this.isScrubbing) this.handleScrub(e);
        };
        const onPointerUp = () => {
            if (this.isScrubbing) {
                this.isScrubbing = false;
                this.dom.videoPlayer.play();
                window.removeEventListener("pointermove", onPointerMove);
                window.removeEventListener("pointerup", onPointerUp);
            }
        };
        this.dom.progressBar.addEventListener("pointerdown", (e) => {
            this.isScrubbing = true;
            this.handleScrub(e as PointerEvent);
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
        });

        this.dom.addPointBtn.addEventListener("click", () => this.store.addSegment(this.dom.videoPlayer.currentTime));
        this.dom.modeOrUndoBtn.addEventListener("click", () => {
            const { segments, playerMode, currentVideo } = this.store.getState();
            if (currentVideo?.type === "original" && playerMode === "edit" && segments.length > 0) {
                this.store.removeLastSegment();
            } else {
                this.store.togglePlayerMode();
            }
        });
        this.dom.videoOkBtn.addEventListener("click", () => this.store.saveCurrentVideo());
        this.dom.deleteOrCutBtn.addEventListener("click", () => {
            const { segments } = this.store.getState();
            if (segments.length > 0) this.store.createEditedVideo();
            else this.store.deleteCurrentVideo();
        });

        this.dom.videoPlayer.addEventListener("timeupdate", this.handleTimeUpdate.bind(this));
        this.dom.videoPlayer.addEventListener("loadedmetadata", () => {
            this.ui.render(this.store.getState());
            this.dom.muteBtn.textContent = this.dom.videoPlayer.muted ? "🔇" : "🔊";
            const { currentVideo } = this.store.getState();
            if (currentVideo) {
                this.store.updateVideoDuration(currentVideo.filename, this.dom.videoPlayer.duration);
            }
        });

        window.addEventListener("scroll", this.handleListViewScroll.bind(this));
    }

    private async requestWakeLock() {
        if ("wakeLock" in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request("screen");
            } catch (err) {
                console.error("Could not acquire Wake Lock:", err);
            }
        }
    }

    private async releaseWakeLock() {
        if (this.wakeLock) {
            await this.wakeLock.release();
            this.wakeLock = null;
        }
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const app = new App();
    app.init();
});
