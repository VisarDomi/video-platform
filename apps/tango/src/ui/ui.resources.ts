import { STREAM_UNIT_STYLES } from "./stream-unit/stream-unit.dom";

export const UI_TEMPLATE = `
<div id="listView">
    <div id="listContainer" class="list-container">
        <div id="videoItemsWrapper"></div>
    </div>
</div>

<div id="videoView">
    <div id="videoContainer"></div>
</div>
`;

export const UI_STYLES = `
    body, html {
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background-color: #000000;
        color: #ffffff;
        -webkit-touch-callout: none;
        width: 100%;
        min-height: 100vh;
        overflow-x: hidden;
    }

    .hidden {
        display: none !important;
    }

    #listView {
        position: relative;
        width: 100%;
        z-index: 1;
        background-color: transparent;
    }

    #listContainer {
        padding-top: env(safe-area-inset-top);
        padding-bottom: calc(50px + env(safe-area-inset-bottom));
    }

    .list-item {
        padding: 12px 15px;
        border-bottom: 1px solid #333;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        justify-content: center;
        min-height: 52px;
        box-sizing: border-box;
        overflow: hidden;
    }

    .list-item:hover {
        background-color: #1a1a1a;
    }

    .list-item-name {
        font-size: 16px;
        font-weight: bold;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.3;
        color: #e0e0e0;
    }

    .list-item-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 4px;
        font-size: 13px;
        color: #aaa;
    }

    .list-item.current-streamer {
        background-color: #1f1f1f;
        border-left: 4px solid #ff5e3a;
    }

    .list-item.is-following .list-item-name {
        color: #4cd137;
    }

    .info-message {
        text-align: center;
        padding: 40px;
        font-style: italic;
        color: #888;
    }

    #videoView {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: black;
        touch-action: none;
        z-index: -1;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.3s ease;
    }

    #videoView.visible {
        z-index: 10;
        opacity: 1;
        pointer-events: auto;
    }

    #videoView.swipe-active {
        box-shadow: -10px 0 30px rgba(0, 0, 0, 0.3);
    }

    #videoView.swipe-animating {
        transition: transform 250ms ease-out;
    }

    #videoContainer {
        width: 100%;
        height: 100%;
        position: relative;
        display: flex;
        justify-content: center;
        align-items: center;
        overflow: hidden;
    }

    ${STREAM_UNIT_STYLES}
`;