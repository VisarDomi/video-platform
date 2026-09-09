import { isPageReload, loadState, saveState } from "../core/state";
import { appendPages } from "../core/pagination";
import { AuthenticationRequiredError } from "../provider/types";
import type { Provider, Stream } from "../provider";

export function streamLabel(provider: Provider, stream: Stream): string {
    return provider.playback === "video" ? stream.firstName : `${stream.alias || stream.streamerId} ${stream.firstName}`.trim();
}

function row(provider: Provider, stream: Stream): HTMLAnchorElement {
    const link = document.createElement("a");
    link.className = "stream-row";
    link.classList.toggle("following", stream.isFollowing);
    link.href = provider.streamUrl(stream.streamId);
    link.dataset.streamerId = stream.streamerId;
    const name = document.createElement("span");
    name.textContent = streamLabel(provider, stream);
    link.append(name);
    return link;
}

function updateRow(provider: Provider, stream: Stream): void {
    const link = document.querySelector<HTMLAnchorElement>(
        `.stream-row[data-streamer-id="${CSS.escape(stream.streamerId)}"]`,
    );
    const name = link?.querySelector("span");
    link?.classList.toggle("following", stream.isFollowing);
    if (name) name.textContent = streamLabel(provider, stream);
}

function render(provider: Provider, streams: Stream[]): () => void {
    const previous = loadState();
    document.title = provider.listTitle;
    document.body.replaceChildren();
    for (const stream of streams) document.body.append(row(provider, stream));
    if (!streams.length) {
        const empty = document.createElement("p");
        empty.className = "status";
        empty.textContent = provider.playback === "video" ? "No uploads yet." : "No live streams are available.";
        document.body.append(empty);
    }

    document.body.onclick = event => {
        const link = (event.target as Element).closest<HTMLAnchorElement>(".stream-row");
        if (!link) return;
        const selected = streams.find(stream => stream.streamerId === link.dataset.streamerId);
        if (!selected) return;
        if (provider.fetchStreamPage) history.replaceState({ ...history.state, streamViewerListScrollY: window.scrollY }, "");
        saveState({
            streams,
            nextPage: loadState()?.nextPage,
            currentStreamerId: selected.streamerId,
        });
    };

    const alignCurrent = (): void => {
        if (!previous?.currentStreamerId) return;
        const current = document.querySelector<HTMLElement>(`[data-streamer-id="${CSS.escape(previous.currentStreamerId)}"]`);
        if (current) {
            current.classList.add("current");
        }
    };
    alignCurrent();
    requestAnimationFrame(alignCurrent);
    return alignCurrent;
}

export async function openHome(provider: Provider): Promise<void> {
    const shared = loadState();
    const initial = shared && !isPageReload() ? shared
        : provider.fetchStreamPage ? await provider.fetchStreamPage()
        : { streams: await provider.fetchStreams(), nextPage: undefined };
    let streams = initial.streams;
    let nextPage = initial.nextPage;
    let stop = () => {};
    let progress: HTMLElement | undefined;

    function persist(): void {
        saveState({ streams, nextPage, currentStreamerId: loadState()?.currentStreamerId ?? "" });
    }

    function resume(): void {
        stop();
        progress?.remove();
        if (!nextPage || document.hidden) return;
        progress = document.createElement("p");
        progress.className = "status uploads-progress";
        progress.textContent = "Loading more uploads…";
        document.body.append(progress);
        stop = appendPages(provider, streams, nextPage, (added, cursor) => {
            nextPage = cursor;
            for (const stream of added) progress!.before(row(provider, stream));
            persist();
            progress!.textContent = "Loading more uploads…";
            if (!nextPage) progress?.remove();
        }, error => {
            if (error instanceof AuthenticationRequiredError && provider.nativeLogin) {
                progress!.classList.add("status-error");
                progress!.textContent = "XVideos login is required. ";
                const login = document.createElement("a");
                login.href = provider.nativeLogin.path;
                login.textContent = "Log in";
                progress!.append(login);
                return;
            }
            progress!.textContent = "Loading more uploads… Retrying automatically.";
        });
    }

    function show(current: Stream[]): void {
        streams = current;
        persist();
        const alignCurrent = render(provider, streams);
        void provider.enrichAll(current).then(enriched => {
            if (streams !== current) return;
            // Keep the array used by row clicks in sync with the displayed names.
            current.splice(0, current.length, ...enriched);
            for (const stream of current) updateRow(provider, stream);
            persist();
            requestAnimationFrame(alignCurrent);
        });
    }

    show(streams);
    // Safari may rebuild a stopped document instead of using bfcache. Store
    // position on the list's own history entry so Back can restore it once the
    // saved rows exist; reload and a newly opened list still start normally.
    if (provider.fetchStreamPage && performance.getEntriesByType("navigation").some(entry => (entry as PerformanceNavigationTiming).type === "back_forward")) {
        const scrollY = history.state?.streamViewerListScrollY;
        if (typeof scrollY === "number" && Number.isFinite(scrollY)) window.scrollTo(0, scrollY);
    }
    resume();
    addEventListener("pagehide", () => stop());

    function restore(): void {
        stop();
        const shared = loadState();
        if (!shared) return;
        if (!provider.fetchStreamPage) {
            show(shared.streams);
            return;
        }
        nextPage = shared.nextPage;
        const existing = Array.from(document.querySelectorAll<HTMLAnchorElement>(".stream-row"));
        if (existing.every((link, index) => link.dataset.streamerId === shared.streams[index]?.streamerId)) {
            // Retain Safari's cached nodes and scroll position. A video opened
            // early may have appended more entries while this list was frozen.
            streams.splice(0, streams.length, ...shared.streams);
            for (const stream of streams.slice(existing.length)) document.body.append(row(provider, stream));
            for (const stream of streams) updateRow(provider, stream);
            for (const link of Array.from(document.querySelectorAll<HTMLAnchorElement>(".stream-row"))) {
                link.classList.toggle("current", link.dataset.streamerId === shared.currentStreamerId);
            }
        } else show(shared.streams);
        resume();
    }
    addEventListener("pageshow", event => {
        if (event.persisted) restore();
    });
    if (provider.fetchStreamPage) document.addEventListener("visibilitychange", () => {
        if (document.hidden) stop();
        else restore();
    });
}
