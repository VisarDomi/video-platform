export const STREAM_UNIT_TEMPLATE = `
<div class="stream-unit">
    <div class="video-container">
        <video class="video-element" playsinline webkit-playsinline autoplay muted></video>

        <div class="top-bar">
            <div class="streamer-name"></div>
            <div class="time-display-container hidden">
                <span class="time-display">00:00.000 / 00:00.000</span>
            </div>
            <div class="progress-bar">
                <div class="progress-fill"></div>
            </div>
            <div class="controls">
                <div class="player-controls-container">
                    <button class="control-btn mute-btn">🔇</button>
                    <button class="control-btn follow-btn" title="Follow/Unfollow">🤍</button>
                    <button class="control-btn block-btn" title="Block">🚫</button>
                </div>
            </div>
        </div>
    </div>
</div>
`;

export const STREAM_UNIT_STYLES = `
    .stream-unit {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: #000;
        display: flex;
        justify-content: center;
        align-items: center;
    }

    .stream-unit[hidden] {
        display: none;
    }

    .stream-unit .video-container {
        width: 100%;
        height: 100%;
        position: relative;
        touch-action: none;
    }

    .stream-unit .video-element {
        width: 100%;
        height: 100%;
        object-fit: contain;
        background-color: #000;
        position: absolute;
        top: 0;
        left: 0;
    }

    .stream-unit .top-bar {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        
        /* Updated padding for safe area */
        padding-top: max(15px, env(safe-area-inset-top));
        padding-left: max(15px, env(safe-area-inset-left));
        padding-right: max(15px, env(safe-area-inset-right));
        padding-bottom: 15px;

        box-sizing: border-box;
        background: linear-gradient(to bottom, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0));
        z-index: 20;
        transition: opacity 0.3s ease;
        opacity: 0;
        pointer-events: none;
    }

    .stream-unit .top-bar.visible {
        opacity: 1;
        pointer-events: auto;
    }

    .stream-unit .streamer-name {
        font-size: 1.2em;
        font-weight: bold;
        text-shadow: 1px 1px 2px black;
        margin-bottom: 10px;
        word-break: break-all;
    }

    .stream-unit .controls {
        display: flex;
        align-items: center;
    }

    .stream-unit .player-controls-container {
        display: flex;
        gap: 10px;
    }

    .stream-unit .control-btn {
        padding: 12px 18px;
        font-size: 36px;
        background-color: rgba(0, 0, 0, 0.6);
        color: white;
        border: 1px solid white;
        border-radius: 8px;
        cursor: pointer;
        min-width: 70px;
        line-height: 1;
        text-align: center;
    }

    .stream-unit .control-btn.btn-unfollow {
        border-color: #ff6b6b !important;
    }

    @media (hover: hover) and (pointer: fine) {
        .stream-unit .control-btn:not(:disabled):hover {
            background-color: #ff5e3a;
            border-color: #ff5e3a;
            color: white !important;
        }
    }

    .stream-unit .control-btn:not(:disabled):active {
        background-color: #ff5e3a;
        border-color: #ff5e3a;
        color: white !important;
    }

    .stream-unit .control-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        background-color: rgba(0, 0, 0, 0.6);
        border-color: #888;
        color: #888;
    }
    
        .stream-unit .time-display-container {
        text-align: center;
        margin-bottom: 8px;
    }

    .stream-unit .time-display {
        display: inline-block;
        background-color: rgba(0, 0, 0, 0.5);
        padding: 4px 12px;
        border-radius: 6px;
        font-family: "Courier New", Courier, monospace;
        font-size: 18px;
        font-weight: bold;
        text-shadow: 1px 1px 2px black;
        color: #f0f0f0;
    }

    .stream-unit .progress-bar {
        width: 100%;
        height: 100px;
        background-color: rgba(255, 255, 255, 0.3);
        border-radius: 10px;
        position: relative;
        overflow: hidden;
        margin-bottom: 10px;
    }

    .stream-unit .progress-fill {
        width: 0;
        height: 100%;
        background-color: #ff5e3a;
        border-radius: 10px;
        position: absolute;
        top: 0;
        left: 0;
    }
`;