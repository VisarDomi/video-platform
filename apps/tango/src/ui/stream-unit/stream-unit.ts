import { Emitter } from "../../core/emitter";
import { Events } from "../../core/events";
import { AliasService } from "../../services/alias.service";
import { DownloadListService } from "../../services/api/download-list.service";
import { LiveUrlService } from "../../video/live-url.service";
import { HlsPlayer } from "../../video/player/hls.player";
import { EventPayloads, IPlayerStrategy, Streamer, UIUpdateState } from "../../types";
import { STREAM_UNIT_TEMPLATE } from "./stream-unit.dom";
import { GestureController, GestureElements, PeekCallbacks } from "../gesture/gesture-controller";

export class StreamUnit {
    public element: HTMLElement;
    public videoElement: HTMLVideoElement;

    private player: IPlayerStrategy | null = null;
    private currentStreamer: Streamer | null = null;

    private emitter: Emitter<EventPayloads>;
    private aliasService: AliasService;
    private liveUrlService: LiveUrlService;
    private downloadListService: DownloadListService;

    // UI Elements
    private nameEl!: HTMLElement;
    private topBarEl!: HTMLElement;
    private muteBtn!: HTMLButtonElement;
    private followBtn!: HTMLButtonElement;
    private blockBtn!: HTMLButtonElement;
    private downloadListBtn!: HTMLButtonElement;

    private blockConfirmState: boolean = false;
    private audioOnly: boolean = false;
    private peekCallbacks?: PeekCallbacks;

    // Ownership token: each update() call increments this.
    // Async continuations only mutate if they still own the current generation.
    private updateGeneration: number = 0;

    constructor(
        emitter: Emitter<EventPayloads>,
        aliasService: AliasService,
        liveUrlService: LiveUrlService,
        downloadListService: DownloadListService,
        gestureElements: GestureElements,
        originalAddEventListener: typeof EventTarget.prototype.addEventListener,
        peekCallbacks?: PeekCallbacks
    ) {
        this.emitter = emitter;
        this.aliasService = aliasService;
        this.liveUrlService = liveUrlService;
        this.downloadListService = downloadListService;
        this.peekCallbacks = peekCallbacks;
        this.element = this._createDOM();
        this.videoElement = this.element.querySelector('video') as HTMLVideoElement;
        this._bindElements();
        this._attachListeners();
        this._initGestures(gestureElements, originalAddEventListener);
    }

    public get isMuted(): boolean {
        return this.videoElement.muted;
    }

    public get hasContent(): boolean {
        return this.currentStreamer !== null;
    }

    public async update(streamer: Streamer | undefined) {
        // Acquire ownership: increment generation and capture token.
        // All async continuations must check owns() — stale generations are no-ops.
        const gen = ++this.updateGeneration;
        const owns = () => this.updateGeneration === gen;

        if (streamer && this.currentStreamer?.streamerId === streamer.streamerId) {
            this.currentStreamer = streamer;
            this._updateNameText(streamer);
            this.updateFollowButton(streamer.isFollowing);
            this.updateDownloadListButton(this.aliasService.getCachedAlias(streamer.streamerId));
            return;
        }

        if (this.player) {
            this.player.destroy();
            this.player = null;
        }
        this.videoElement.src = "";
        this.currentStreamer = streamer || null;
        this.blockConfirmState = false;
        this.audioOnly = false;
        this.blockBtn.textContent = "🚫";

        if (!streamer) {
            this.nameEl.textContent = "";
            return;
        }

        const targetStreamerId = streamer.streamerId;

        // Immediate UI Update (Uses whatever is currently in memory/cache)
        this._updateNameText(streamer);
        this.updateFollowButton(streamer.isFollowing);
        this.updateDownloadListButton(this.aliasService.getCachedAlias(streamer.streamerId));

        // Async: Fetch Alias & Name.
        // We use .then() to trigger a re-render of the text without blocking video loading.
        this.aliasService.getAliasFor(streamer.streamerId).then(() => {
            if (!owns()) return;
            this._updateNameText(this.currentStreamer!);
            this.updateDownloadListButton(this.aliasService.getCachedAlias(targetStreamerId));
        });

        // Async: Video
        try {
            const cachedAlias = this.aliasService.getCachedAlias(targetStreamerId) || targetStreamerId;
            const liveUrl = await this.liveUrlService.fetchAndParseLiveUrl(streamer, cachedAlias);

            if (!owns()) return;

            if (liveUrl) {
                const finalAlias = this.aliasService.getCachedAlias(targetStreamerId) || targetStreamerId;
                this.player = new HlsPlayer(this.videoElement, {
                    onReady: () => {
                        this.emitter.emit(Events.DEBUG.LOG, {
                            message: `${finalAlias} -> Live: OK`,
                            type: 'success'
                        });
                    },
                    onFatalError: (type) => {
                        if (!owns()) return;
                        this.emitter.emit(Events.DEBUG.LOG, {
                            message: `${finalAlias} -> Live: ERROR (${type})`,
                            type: 'error'
                        });
                        if (type === 'network') {
                            this.emitter.emit(Events.APP.REMOVE_STREAMER, streamer.streamerId);
                        }
                    },
                });
                this.player.loadSource(liveUrl);
                this._detectAudioOnly(gen);
            } else {
                this.emitter.emit(Events.APP.REMOVE_STREAMER, streamer.streamerId);
            }

        } catch (e) {
            console.error("StreamUnit update failed", e);
        }
    }

    private _detectAudioOnly(ownerGen: number) {
        const onPlaying = () => {
            this.videoElement.removeEventListener('playing', onPlaying);
            if (this.updateGeneration !== ownerGen) return;
            if (this.videoElement.videoWidth === 0 || this.videoElement.videoHeight === 0) {
                this.audioOnly = true;
                if (this.currentStreamer) this._updateNameText(this.currentStreamer);
            }
        };
        this.videoElement.addEventListener('playing', onPlaying);
    }

    private _updateNameText(streamer: Streamer) {
        // 1. Get cached alias or fallback to ID
        const cachedAlias = this.aliasService.getCachedAlias(streamer.streamerId);
        const displayAlias = cachedAlias || streamer.streamerId;

        // 2. Get name. Prioritize cached name (in case streamer object is stale), then streamer.firstName
        const cachedName = this.aliasService.getCachedName(streamer.streamerId);
        const displayName = cachedName || streamer.firstName;

        const audioTag = this.audioOnly ? ' 🔊' : '';
        this.nameEl.textContent = `${displayAlias} ${displayName}${audioTag}`;
    }

    private onGlobalUiUpdate = (_payload: UIUpdateState) => {
        if (this.currentStreamer) {
            this._updateNameText(this.currentStreamer);
            this.updateFollowButton(this.currentStreamer.isFollowing);
            this.updateDownloadListButton(this.aliasService.getCachedAlias(this.currentStreamer.streamerId));
        }
    }

    public setHidden(hidden: boolean) {
        this.element.hidden = hidden;
    }

    public setMuted(muted: boolean) {
        this.videoElement.muted = muted;
        this.muteBtn.textContent = muted ? "🔇" : "🔊";
    }

    public play() {
        this.videoElement.play().catch(e => console.error("Autoplay failed", e));
    }

    public resume() {
        if (this.player) {
            this.player.resume();
        }
    }

    private _createDOM(): HTMLElement {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = STREAM_UNIT_TEMPLATE;
        return wrapper.firstElementChild as HTMLElement;
    }

    private _bindElements() {
        this.nameEl = this.element.querySelector('.streamer-name') as HTMLElement;
        this.topBarEl = this.element.querySelector('.top-bar') as HTMLElement;
        this.muteBtn = this.element.querySelector('.mute-btn') as HTMLButtonElement;
        this.followBtn = this.element.querySelector('.follow-btn') as HTMLButtonElement;
        this.blockBtn = this.element.querySelector('.block-btn') as HTMLButtonElement;
        this.downloadListBtn = this.element.querySelector('.download-list-btn') as HTMLButtonElement;
    }

    private _initGestures(gestureElements: GestureElements, originalAddEventListener: typeof EventTarget.prototype.addEventListener) {
        const container = this.element.querySelector('.video-container') as HTMLElement;
        new GestureController(container, {
            onNext: () => this.emitter.emit(Events.UI.NEXT),
            onPrevious: () => this.emitter.emit(Events.UI.PREVIOUS),
            onShowList: () => this.emitter.emit(Events.UI.SHOW_LIST),
            onSetUiVisible: (visible) => this.emitter.emit(Events.UI.SET_UI_VISIBLE, visible),
        }, gestureElements, originalAddEventListener, this.peekCallbacks);
    }

    private _attachListeners() {
        this.emitter.on(Events.APP.UPDATE_UI, this.onGlobalUiUpdate);

        this.muteBtn.addEventListener("click", () => {
            this.emitter.emit(Events.UI.TOGGLE_MUTE);
        });

        this.followBtn.addEventListener("click", () => {
            const isFollowing = this.followBtn.dataset.following === "true";
            if (isFollowing) {
                this.emitter.emit(Events.UI.UNFOLLOW);
            } else {
                this.emitter.emit(Events.UI.FOLLOW);
            }
        });

        this.blockBtn.addEventListener("click", () => {
            if (!this.blockConfirmState) {
                this.blockConfirmState = true;
                this.blockBtn.textContent = "❓";
            } else {
                this.emitter.emit(Events.UI.BLOCK);
                this.blockConfirmState = false;
                this.blockBtn.textContent = "🚫";
            }
        });

        this.downloadListBtn.addEventListener("click", () => {
            const isInList = this.downloadListBtn.dataset.inList === "true";
            if (isInList) {
                this.emitter.emit(Events.UI.REMOVE_FROM_DOWNLOAD_LIST);
            } else {
                this.emitter.emit(Events.UI.ADD_TO_DOWNLOAD_LIST);
            }
        });
    }

    public setUiVisible(visible: boolean) {
        if (visible) {
            this.topBarEl.classList.add("visible");
        } else {
            this.topBarEl.classList.remove("visible");
        }
    }

    private updateDownloadListButton(alias: string | undefined) {
        if (!alias) {
            this.downloadListBtn.dataset.inList = "false";
            this.downloadListBtn.textContent = "📥";
            this.downloadListBtn.classList.remove("btn-unfollow");
            return;
        }
        const inList = this.downloadListService.isInList(alias);
        this.downloadListBtn.dataset.inList = String(inList);
        this.downloadListBtn.textContent = inList ? "✅" : "📥";
        this.downloadListBtn.classList.toggle("btn-unfollow", inList);
    }

    private updateFollowButton(isFollowing: boolean) {
        this.followBtn.dataset.following = String(isFollowing);
        this.followBtn.textContent = isFollowing ? "❤️" : "🤍";
        this.followBtn.classList.remove("btn-follow", "btn-unfollow");

        if (isFollowing) {
            this.followBtn.classList.add("btn-unfollow");
        } else {
            this.followBtn.classList.add("btn-follow");
        }
    }
}
