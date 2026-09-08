import { isPageReload, loadState, saveState } from "../core/state";
import type { Provider, Stream } from "../provider";

function row(provider: Provider, stream: Stream): HTMLAnchorElement {
    const link = document.createElement("a");
    link.className = "stream-row";
    link.classList.toggle("following", stream.isFollowing);
    link.href = provider.streamUrl(stream.streamId);
    link.dataset.streamerId = stream.streamerId;
    const name = document.createElement("span");
    name.textContent = `${stream.alias || stream.streamerId} ${stream.firstName}`.trim();
    link.append(name);
    return link;
}

function updateRow(stream: Stream): void {
    const link = document.querySelector<HTMLAnchorElement>(
        `.stream-row[data-streamer-id="${CSS.escape(stream.streamerId)}"]`,
    );
    const name = link?.querySelector("span");
    if (name) name.textContent = `${stream.alias || stream.streamerId} ${stream.firstName}`.trim();
}

function render(provider: Provider, streams: Stream[]): () => void {
    const previous = loadState();
    document.title = "Streams";
    document.body.replaceChildren();
    for (const stream of streams) document.body.append(row(provider, stream));

    document.body.onclick = event => {
        const link = (event.target as Element).closest<HTMLAnchorElement>(".stream-row");
        if (!link) return;
        const selected = streams.find(stream => stream.streamerId === link.dataset.streamerId);
        if (!selected) return;
        saveState({
            streams,
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
    let streams = shared && !isPageReload() ? shared.streams : await provider.fetchStreams();

    function show(current: Stream[]): void {
        streams = current;
        const currentStreamerId = loadState()?.currentStreamerId ?? "";
        saveState({ streams, currentStreamerId });
        const alignCurrent = render(provider, streams);
        void provider.enrichAll(current).then(enriched => {
            if (streams !== current) return;
            // Keep the array used by row clicks in sync with the displayed names.
            current.splice(0, current.length, ...enriched);
            for (const stream of current) updateRow(stream);
            saveState({ streams, currentStreamerId: loadState()?.currentStreamerId ?? "" });
            requestAnimationFrame(alignCurrent);
        });
    }

    show(streams);

    addEventListener("pageshow", event => {
        if (!event.persisted) return;
        const shared = loadState();
        if (!shared) return;
        show(shared.streams);
    });
}
