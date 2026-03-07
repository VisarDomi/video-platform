import { CONSTANTS } from "../core/constants";
import { Emitter } from "../core/emitter";
import { Events } from "../core/events";
import { EventPayloads } from "../types";
import { UI_TEMPLATE } from "./ui.resources";

export class UIManager {
    private dom: HTMLElement;
    private emitter: Emitter<EventPayloads>;

    private listView!: HTMLDivElement;
    private videoView!: HTMLDivElement;
    private videoPlayerContainer!: HTMLDivElement;

    constructor(emitter: Emitter<EventPayloads>) {
        this.emitter = emitter;
        this.dom = this._createDOM();
        this._bindElements();
    }

    public registerListeners() {
        this.emitter.on(Events.APP.STATE_CHANGED, (state) => {
            this.updateViewMode(state.viewMode);
        });
    }

    public get videosContainer(): HTMLDivElement {
        return this.videoPlayerContainer;
    }

    public get videoViewElement(): HTMLElement {
        return this.videoView;
    }

    public get listViewElement(): HTMLElement {
        return this.listView;
    }

    private _createDOM(): HTMLElement {
        const container = document.createElement("div");
        container.id = CONSTANTS.DOM.UI_CONTAINER_ID;
        container.innerHTML = UI_TEMPLATE;
        document.body.appendChild(container);
        return container;
    }

    private _bindElements() {
        this.listView = this.dom.querySelector(`#${CONSTANTS.DOM.LIST_VIEW}`) as HTMLDivElement;
        this.videoView = this.dom.querySelector("#videoView") as HTMLDivElement;
        this.videoPlayerContainer = this.dom.querySelector("#videoContainer") as HTMLDivElement;
    }

    private updateViewMode(viewMode: 'list' | 'video') {
        if (viewMode === 'list') {
            this.listView.classList.remove('hidden-view');
            this.videoView.classList.add('hidden-view');
        } else {
            this.listView.classList.add('hidden-view');
            this.videoView.classList.remove('hidden-view');
        }
    }
}