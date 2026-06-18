import { CONSTANTS } from "./constants";

interface OriginalFunctions {
    setInterval: typeof window.setInterval;
    setTimeout: typeof window.setTimeout;
    addEventListener: typeof EventTarget.prototype.addEventListener;
}

export function preparePageEnvironment(): OriginalFunctions {
    const originalSetInterval = window.setInterval;
    const originalSetTimeout = window.setTimeout;

    window.setInterval = function (fn, delay, ...args) {
        const fnString = fn.toString();
        if (fnString.includes(CONSTANTS.DOM.SCRIPT_ELEMENT_ID_PREFIX)) {
            return originalSetInterval(fn, delay, ...args);
        }
        return -1;
    };

    window.setTimeout = function (fn, delay, ...args) {
        const stack = new Error().stack;
        if (stack && stack.includes("hls")) {
            return originalSetTimeout(fn, delay, ...args);
        }
        return -1;
    };

    window.requestAnimationFrame = (() => {}) as any;

    WebSocket.prototype.send = () => {};

    window.MutationObserver = class {
        constructor() {
            return {
                observe() {},
                disconnect() {},
                takeRecords() {
                    return [];
                },
            };
        }
    } as any;

    const noisyEvents = ["scroll", "mousemove", "resize", "touchmove", "touchstart"];
    const originalAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (noisyEvents.includes(type)) {
            return;
        }
        return originalAddEventListener.call(this, type, listener, options);
    };

    for (let i = 1; i < 99999; i++) {
        clearInterval(i);
        clearTimeout(i);
        cancelAnimationFrame(i);
    }

    return {
        setInterval: originalSetInterval,
        setTimeout: originalSetTimeout,
        addEventListener: originalAddEventListener,
    };
}

export function startDOMSanitizer(originalSetInterval: typeof window.setInterval) {
    const metaId = `${CONSTANTS.DOM.SCRIPT_ELEMENT_ID_PREFIX}_viewport`;
    if (!document.getElementById(metaId)) {
        const meta = document.createElement('meta');
        meta.id = metaId;
        meta.name = "viewport";
        meta.content = "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";
        document.head.appendChild(meta);
    }

    originalSetInterval(() => {
        document.documentElement.className = "";
        document.body.style.cssText = "";
        document.body.className = "";
        document.body.style.backgroundColor = "black";
        document.body.style.margin = "0";
        document.body.style.padding = "0";

        document.body.id = CONSTANTS.DOM.BODY_ID;
        document.head.id = CONSTANTS.DOM.HEAD_ID;

        for (const child of Array.from(document.body.children)) {
            if (!child.id.includes(CONSTANTS.DOM.SCRIPT_ELEMENT_ID_PREFIX)) child.remove();
        }
        for (const child of Array.from(document.head.children)) {
            if (child.nodeName === "TITLE") {
                child.innerHTML = "Tango";
            } else if (!child.id.includes(CONSTANTS.DOM.SCRIPT_ELEMENT_ID_PREFIX)) {
                child.remove();
            }
        }
        for (const child of Array.from(document.documentElement.children)) {
            if (!child.id.includes(CONSTANTS.DOM.SCRIPT_ELEMENT_ID_PREFIX)) child.remove();
        }
    }, 1000);
}