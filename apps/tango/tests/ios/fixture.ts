import { takeOverPage, showStatus } from "../../src/core/page";
import { openHome } from "../../src/routes/home";
import { openStream } from "../../src/routes/stream";
import type { Provider, Stream } from "../../src/provider";

const FIXTURE_KEY = "stream-viewer-fixture";

interface FixtureState {
    fetches: Stream[][];
    fetchCount?: number;
    fetchDelay?: number;
    costreamers?: Record<string, Stream[]>;
    enrichDelay?: number;
    enriched?: Record<string, Partial<Stream>>;
    downloads?: string[];
    actions?: { action: string; streamerId: string }[];
}

function load(): FixtureState {
    const state = JSON.parse(sessionStorage.getItem(FIXTURE_KEY) ?? "null") as FixtureState | null;
    if (!state?.fetches?.length) throw new Error("Missing stream-viewer fixture state.");
    return state;
}

function save(state: FixtureState): void {
    sessionStorage.setItem(FIXTURE_KEY, JSON.stringify(state));
}

function delay(milliseconds = 0): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function record(action: string, streamerId: string): void {
    const state = load();
    state.actions ??= [];
    state.actions.push({ action, streamerId });
    save(state);
}

function enrich(stream: Stream, state: FixtureState): Stream {
    return { ...stream, ...state.enriched?.[stream.streamerId] };
}

Object.defineProperties(HTMLMediaElement.prototype, {
    readyState: { configurable: true, get: () => HTMLMediaElement.HAVE_ENOUGH_DATA },
    videoWidth: {
        configurable: true,
        get(this: HTMLMediaElement) {
            return this.dataset.audioOnly === "true" ? 0 : 640;
        },
    },
    videoHeight: {
        configurable: true,
        get(this: HTMLMediaElement) {
            return this.dataset.audioOnly === "true" ? 0 : 360;
        },
    },
});

HTMLMediaElement.prototype.load = function load(): void {};
HTMLMediaElement.prototype.pause = function pause(): void {};
HTMLMediaElement.prototype.play = async function play(): Promise<void> {
    queueMicrotask(() => this.dispatchEvent(new Event("playing")));
};

const addMediaListener = HTMLMediaElement.prototype.addEventListener;
HTMLMediaElement.prototype.addEventListener = function addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
): void {
    if ((type === "error" || type === "playing") && typeof listener === "function") {
        addMediaListener.call(this, type, event => {
            if ((event as Event & { fixtureTriggered?: boolean }).fixtureTriggered) {
                listener.call(this, event);
            }
        }, options);
        return;
    }
    addMediaListener.call(this, type, listener, options);
};

const provider: Provider = {
    name: "fixture",
    matches: ["https://example.com/*"],

    matchRoute(pathname) {
        const match = pathname.match(/^\/fixture\/stream\/([^/]+)/);
        return match
            ? { handler: 1, streamId: decodeURIComponent(match[1]) }
            : { handler: 0 };
    },

    streamUrl(streamId) {
        return `/fixture/stream/${encodeURIComponent(streamId)}`;
    },

    async startAuthentication() {
        return () => {};
    },

    async refreshStreamTokens() {},

    async fetchStreams() {
        const state = load();
        if (state.fetchDelay) await delay(state.fetchDelay);
        const index = state.fetchCount ?? 0;
        const streams = state.fetches[Math.min(index, state.fetches.length - 1)] ?? [];
        state.fetchCount = index + 1;
        save(state);
        return structuredClone(streams);
    },

    async fetchCostreamers(stream) {
        return structuredClone(load().costreamers?.[stream.streamerId] ?? []);
    },

    async enrichAll(streams) {
        const state = load();
        await delay(state.enrichDelay);
        return streams.map(stream => enrich(stream, state));
    },

    async enrich(stream) {
        const state = load();
        await delay(state.enrichDelay);
        return enrich(stream, state);
    },

    async follow(streamerId) {
        record("follow", streamerId);
    },

    async unfollow(streamerId) {
        record("unfollow", streamerId);
    },

    async block(streamerId) {
        record("block", streamerId);
    },

    async fetchDownloadList() {
        return new Set(load().downloads ?? []);
    },

    async addToDownloadList(streamerId) {
        const state = load();
        state.downloads ??= [];
        if (!state.downloads.includes(streamerId)) state.downloads.push(streamerId);
        save(state);
        record("download-add", streamerId);
    },

    async removeFromDownloadList(streamerId) {
        const state = load();
        state.downloads = (state.downloads ?? []).filter(id => id !== streamerId);
        save(state);
        record("download-remove", streamerId);
    },
};

async function main(): Promise<void> {
    takeOverPage();
    showStatus("Loading fixture…");
    try {
        if (location.pathname.startsWith("/fixture/stream/")) {
            const streamId = decodeURIComponent(location.pathname.slice("/fixture/stream/".length));
            await openStream(provider, streamId);
        } else {
            await openHome(provider);
        }
    } catch (error) {
        showStatus(error instanceof Error ? error.message : "Fixture failed.", true);
    }
}

void main();
