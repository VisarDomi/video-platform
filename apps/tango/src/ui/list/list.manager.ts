import { CONSTANTS } from "../../core/constants";
import { Emitter } from "../../core/emitter";
import { Events } from "../../core/events";
import { AliasService } from "../../services/alias.service";
import { AppState } from "../../core/app.state";
import { EventPayloads, IApplicationState, Streamer, ViewMode } from "../../types";

export class ListManager {
    private dom: {
        listView: HTMLElement;
        videoItemsWrapper: HTMLElement;
    };
    private emitter: Emitter<EventPayloads>;
    private appState: AppState;
    private aliasService: AliasService;
    private lastRenderedState: string | null = null;
    private intersectionObserver: IntersectionObserver;
    private previousViewMode: ViewMode = 'list';

    constructor(appState: AppState, emitter: Emitter<EventPayloads>, aliasService: AliasService) {
        this.appState = appState;
        this.emitter = emitter;
        this.aliasService = aliasService;

        this.dom = {
            listView: document.getElementById(CONSTANTS.DOM.LIST_VIEW) as HTMLElement,
            videoItemsWrapper: document.getElementById(CONSTANTS.DOM.VIDEO_ITEMS_WRAPPER) as HTMLElement,
        };

        this.intersectionObserver = new IntersectionObserver((entries) => {
            if (entries.some(entry => entry.isIntersecting)) {
                this.emitter.emit(Events.APP.LOAD_MORE_STREAMERS);
            }
        }, { threshold: 0.1 });
    }

    public registerListeners() {
        this.emitter.on(Events.APP.STATE_CHANGED, this.onStateChanged);
        this.emitter.on(Events.APP.UPDATE_UI, this.onUiUpdate);

        this.dom.videoItemsWrapper.addEventListener("click", this.handleItemClick);
    }

    public initialize() {
        const state = this.appState.getState();
        this.render(state);
        this.previousViewMode = state.viewMode;
    }

    private onStateChanged = (state: IApplicationState) => {
        this.render(state);

        if (state.viewMode === 'video') {
            this.scrollToTarget();
        }

        this.previousViewMode = state.viewMode;
    }

    private onUiUpdate = () => {
        this.render(this.appState.getState());
    }

    private handleItemClick = (e: Event) => {
        const target = e.target as HTMLElement;
        const item = target.closest(".list-item") as HTMLElement;
        if (item && item.dataset.streamerId) {
            const rect = item.getBoundingClientRect();
            this.appState.captureScrollAnchor(rect.top);
            this.emitter.emit(Events.UI.PLAY_STREAMER, item.dataset.streamerId);
        }
    }

    private async render(state: IApplicationState) {
        const { streamers, currentIndex } = state;
        const activeStreamer = streamers[currentIndex];

        // Include names in signature to detect when "..." changes to "RealName"
        const currentDisplayNames = streamers.map(s => this.getDisplayName(s));

        const currentStateSignature = JSON.stringify({
            streamerIds: streamers.map(s => s.streamerId),
            activeId: activeStreamer?.streamerId,
            followingStates: streamers.map(s => s.isFollowing),
            displayNames: currentDisplayNames
        });

        if (this.lastRenderedState === currentStateSignature && this.dom.videoItemsWrapper.hasChildNodes()) {
            return;
        }

        this.lastRenderedState = currentStateSignature;

        this.intersectionObserver.disconnect();

        if (streamers.length === 0) {
            this.dom.videoItemsWrapper.innerHTML = `<div class="info-message">No streamers found.</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();

        streamers.forEach(streamer => {
            const displayName = this.getDisplayName(streamer);
            const item = this.createStreamerItem(streamer, displayName, activeStreamer?.streamerId === streamer.streamerId);
            fragment.appendChild(item);
        });

        this.dom.videoItemsWrapper.innerHTML = "";
        this.dom.videoItemsWrapper.appendChild(fragment);

        const lastItem = this.dom.videoItemsWrapper.lastElementChild;
        if (lastItem) {
            this.intersectionObserver.observe(lastItem);
        }
    }

    private scrollToTarget() {
        const target = this.appState.scrollTarget;
        if (!target) return;
        const el = this.dom.videoItemsWrapper.querySelector(
            `.list-item[data-streamer-id="${target.streamerId}"]`
        ) as HTMLElement | null;
        if (!el) return;
        const targetY = Math.max(0, el.offsetTop - target.anchorY);
        window.scrollTo(0, targetY);
    }

    private getDisplayName(streamer: Streamer): string {
        const alias = this.aliasService.getCachedAlias(streamer.streamerId);
        const displayAlias = alias || streamer.streamerId;

        // Check cache for name, fallback to streamer object (which might be "..." or might be updated in memory)
        const cachedName = this.aliasService.getCachedName(streamer.streamerId);
        const displayName = cachedName || streamer.firstName;

        return `${displayAlias} ${displayName}`;
    }

    private createStreamerItem(streamer: Streamer, displayName: string, isActive: boolean): HTMLElement {
        const item = document.createElement("div");
        item.className = "list-item";
        item.dataset.streamerId = streamer.streamerId;

        if (isActive) item.classList.add("current-streamer");
        if (streamer.isFollowing) item.classList.add("is-following");

        const nameSpan = document.createElement("span");
        nameSpan.className = "list-item-name";
        nameSpan.textContent = displayName;

        const metaDiv = document.createElement("div");
        metaDiv.className = "list-item-meta";

        let metaText = streamer.isFollowing ? "Following" : "Recommended";

        if (streamer.parentStreamerId) {
            const parentAlias = this.aliasService.getCachedAlias(streamer.parentStreamerId) || streamer.parentStreamerId;
            metaText = `Co-streamer of ${parentAlias}`;
        }

        metaDiv.textContent = metaText;

        item.appendChild(nameSpan);
        item.appendChild(metaDiv);
        return item;
    }
}