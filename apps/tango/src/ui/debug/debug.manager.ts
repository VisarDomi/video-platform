import { CONSTANTS } from "../../core/constants";
import { Emitter } from "../../core/emitter";
import { Events } from "../../core/events";
import { DebugLogPayload, EventPayloads } from "../../types";

export class DebugManager {
    private dom: HTMLElement;
    private list: HTMLElement;
    private emitter: Emitter<EventPayloads>;

    constructor(emitter: Emitter<EventPayloads>) {
        this.emitter = emitter;
        this.dom = this.createDom();
        this.list = this.dom.querySelector('.debug-list') as HTMLElement;
    }

    public registerListeners() {
        this.emitter.on(Events.DEBUG.LOG, this.onLog);
    }

    private onLog = (payload: DebugLogPayload) => {
        const item = document.createElement('div');
        const time = new Date().toLocaleTimeString().split(' ')[0];

        item.style.marginBottom = '4px';
        item.style.fontSize = '12px';
        item.style.fontFamily = 'monospace';
        item.style.borderBottom = '1px solid #333';
        item.style.padding = '4px 0';

        const color = payload.type === 'success' ? '#4cd137' : payload.type === 'error' ? '#e84118' : '#f5f6fa';
        item.style.color = color;

        item.textContent = `[${time}] ${payload.message}`;

        this.list.insertBefore(item, this.list.firstChild);

        if (this.list.children.length > 50) {
            this.list.lastChild?.remove();
        }
    }

    private createDom(): HTMLElement {
        const container = document.createElement('div');
        container.id = `${CONSTANTS.DOM.SCRIPT_ELEMENT_ID_PREFIX}_debugOverlay`;
        container.style.position = 'fixed';
        container.style.top = '0';
        container.style.right = '0';
        container.style.bottom = '0';
        container.style.width = '300px';
        container.style.backgroundColor = 'rgba(0, 0, 0, 0.85)';
        container.style.borderLeft = '1px solid #444';
        container.style.zIndex = '101';
        container.style.padding = '10px';
        container.style.pointerEvents = 'none';
        container.style.overflowY = 'hidden';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';

        const title = document.createElement('div');
        title.textContent = 'Debug Log';
        title.style.fontWeight = 'bold';
        title.style.marginBottom = '10px';
        title.style.color = '#fff';
        title.style.textAlign = 'center';
        title.style.borderBottom = '2px solid #555';
        title.style.paddingBottom = '5px';

        const list = document.createElement('div');
        list.className = 'debug-list';
        list.style.flex = '1';
        list.style.overflow = 'hidden';

        container.appendChild(title);
        container.appendChild(list);

        document.body.appendChild(container);
        return container;
    }
}