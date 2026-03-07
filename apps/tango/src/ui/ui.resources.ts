import { STREAM_UNIT_STYLES } from "./stream-unit/stream-unit.dom";

export const UI_TEMPLATE = `
<div id="listView">
    <div id="listContainer" class="list-container">
        <div id="videoItemsWrapper"></div>
    </div>
</div>

<div id="videoView" class="hidden-view">
    <div id="videoContainer">
        <!-- StreamUnits injected here -->
    </div>
</div>
`;

export const UI_STYLES = `
    /* Base Resets */
    body, html {
        margin: 0;
        padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        background-color: #000000;
        color: #ffffff;
        -webkit-touch-callout: none;
        
        /* Native Document Scrolling Setup */
        width: 100%;
        min-height: 100vh; /* Ensure body covers the screen to provide black background for over-scroll */
        overflow-x: hidden; /* Prevent horizontal drift */
        /* overflow-y is implicitly visible, allowing native scroll */
    }

    .hidden {
        display: none !important;
    }

    /* List View */
    #listView {
        position: relative;
        width: 100%;
        z-index: 1;
        background-color: transparent; /* Transparent so body background shows through */
        transition: opacity 0.3s ease;
    }

    #listView.hidden-view {
        display: none; 
    }

    #listContainer {
        /* Padding for Safe Areas (Notch & Home Indicator) */
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

    /* Video View */
    #videoView {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: black;
        touch-action: none;
        z-index: 10;
        transition: opacity 0.3s ease;
    }
    
    #videoView.swipe-active {
        box-shadow: -10px 0 30px rgba(0, 0, 0, 0.3);
    }

    #videoView.swipe-animating {
        transition: transform 250ms ease-out;
    }

    #videoView.hidden-view {
        /* Crucial for iOS: completely remove fixed element from render tree 
           to allow transparent bars in list view */
        display: none; 
    }

    #videoContainer {
        width: 100%;
        height: 100%;
        position: relative;
        display: flex;
        justify-content: center;
        align-items: center;
    }

    ${STREAM_UNIT_STYLES}
`;