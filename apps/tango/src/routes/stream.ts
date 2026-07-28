import { loadState, saveState } from "../core/state";
import type { Provider, Stream } from "../provider";
import { attachGestures } from "../ui/gestures";

interface Slot {
    element: HTMLElement;
    video: HTMLVideoElement;
    stream?: Stream;
}

export async function openStream(provider: Provider, requestedStreamId: string): Promise<void> {
    const shared = loadState();
    const freshStreams = provider.fetchStreams();
    const handedOff = shared?.streams.some(stream => stream.streamId === requestedStreamId) === true;
    const streams = handedOff ? [...shared.streams] : await freshStreams;
    let index = streams.findIndex(stream => stream.streamId === requestedStreamId);
    if (index < 0) index = 0;
    if (!streams[index]) throw new Error("No live streams are available.");

    document.body.replaceChildren();
    document.body.className = "stream-page";
    const stage = document.createElement("main");
    stage.className = "stream-stage";
    document.body.append(stage);

    let slots = [-1, 0, 1].map(offset => createSlot(offset));
    stage.append(...slots.map(slot => slot.element));
    let controlsVisible = true;
    let moving = false;
    const removing = new Set<string>();
    const removed = new Set<string>();
    let downloads = new Set<string>();
    void provider.fetchDownloadList().then(result => {
        downloads = result;
        updateControls();
    }).catch(() => {});

    function adjacent(offset: number): Stream | undefined {
        return streams[index + offset];
    }

    function setSlot(slot: Slot, stream: Stream | undefined): void {
        if (slot.stream?.streamerId === stream?.streamerId) return;
        slot.stream = undefined;
        slot.video.pause();
        slot.video.removeAttribute("src");
        slot.video.load();
        if (!stream) {
            slot.element.hidden = true;
            return;
        }
        slot.stream = stream;
        slot.element.hidden = false;
        slot.video.src = stream.masterListUrl;
        slot.video.muted = true;
        slot.video.load();
    }

    function updateSlots(): void {
        setSlot(slots[0], adjacent(-1));
        setSlot(slots[1], adjacent(0));
        setSlot(slots[2], adjacent(1));
        slots[1].video.muted = true;
        void slots[1].video.play();
        updateControls();
    }

    function persist(): void {
        const selectedTop = shared?.selectedTop ?? 0;
        saveState({ streams, currentStreamerId: streams[index].streamerId, selectedTop });
    }

    function updateControls(): void {
        const stream = streams[index];
        if (!stream) return;
        document.title = stream.alias || stream.firstName;
        const controls = slots[1].element.querySelector<HTMLElement>(".stream-controls");
        if (!controls) return;
        controls.classList.toggle("hidden", !controlsVisible);
        controls.querySelector<HTMLElement>(".stream-name")!.textContent =
            `${stream.alias || stream.streamerId} ${stream.firstName}`.trim();
        const mute = controls.querySelector<HTMLButtonElement>(".mute")!;
        mute.textContent = slots[1].video.muted ? "🔇" : "🔊";
        const follow = controls.querySelector<HTMLButtonElement>(".follow")!;
        follow.textContent = stream.isFollowing ? "❤️" : "🤍";
        follow.classList.toggle("remove", stream.isFollowing);
        const block = controls.querySelector<HTMLButtonElement>(".block")!;
        block.dataset.confirm = "false";
        block.textContent = "🚫";
        const download = controls.querySelector<HTMLButtonElement>(".download")!;
        const downloaded = downloads.has(stream.streamerId);
        download.textContent = downloaded ? "➖" : "➕";
        download.classList.toggle("add", !downloaded);
        download.classList.toggle("remove", downloaded);
    }

    async function discover(stream: Stream): Promise<void> {
        const additions = await provider.fetchCostreamers(stream).catch(() => []);
        const available = additions.filter(item => !removed.has(item.streamerId));
        if (!available.length) return;
        const discovered = available.map(addition => {
            const existing = streams.find(item => item.streamerId === addition.streamerId);
            return existing
                ? {
                    ...addition,
                    ...existing,
                    streamId: addition.streamId,
                    masterListUrl: addition.masterListUrl,
                    parentStreamerId: stream.streamerId,
                }
                : addition;
        });
        const selectedId = streams[index]?.streamerId;
        const discoveredIds = new Set(discovered.map(item => item.streamerId));
        for (let position = streams.length - 1; position >= 0; position--) {
            if (discoveredIds.has(streams[position].streamerId)) streams.splice(position, 1);
        }
        const parentIndex = streams.findIndex(item => item.streamerId === stream.streamerId);
        if (parentIndex < 0) return;
        streams.splice(parentIndex + 1, 0, ...discovered);
        index = streams.findIndex(item => item.streamerId === selectedId);
        if (index < 0) index = parentIndex;
        persist();
        updateSlots();
    }

    async function select(nextIndex: number): Promise<void> {
        if (!streams[nextIndex]) {
            resetTransforms();
            return;
        }
        index = nextIndex;
        resetTransforms();
        updateSlots();
        const current = await provider.enrich(streams[index]);
        streams[index] = current;
        history.replaceState(null, "", provider.streamUrl(current.streamId));
        persist();
        updateControls();
        void discover(current);
    }

    async function remove(streamerId: string): Promise<void> {
        if (removing.has(streamerId)) return;
        removing.add(streamerId);
        const failedIndex = streams.findIndex(stream => stream.streamerId === streamerId);
        if (failedIndex < 0) {
            removing.delete(streamerId);
            return;
        }
        removed.add(streamerId);
        const failedCurrent = failedIndex === index;
        const costreamerId = failedCurrent
            ? streams.find(stream => stream.parentStreamerId === streamerId)?.streamerId
            : undefined;
        streams.splice(failedIndex, 1);
        if (!streams.length) {
            document.body.replaceChildren();
            const message = document.createElement("p");
            message.className = "status";
            message.textContent = "No live streams are available.";
            document.body.append(message);
            removing.delete(streamerId);
            return;
        }
        if (failedCurrent && costreamerId) {
            const costreamerIndex = streams.findIndex(stream => stream.streamerId === costreamerId);
            index = costreamerIndex >= 0 ? costreamerIndex : Math.min(index, streams.length - 1);
        } else if (failedIndex < index) index--;
        else if (index >= streams.length) index = streams.length - 1;
        await select(index);
        removing.delete(streamerId);
    }

    function resetTransforms(): void {
        moving = false;
        slots.forEach((slot, position) => {
            slot.element.style.transition = "";
            slot.element.style.transform = `translateY(${(position - 1) * 100}%)`;
        });
    }

    attachGestures(stage, {
        move(delta) {
            if (moving) return;
            slots.forEach((slot, position) => {
                slot.element.style.transition = "none";
                slot.element.style.transform = `translateY(calc(${(position - 1) * 100}% + ${delta}px))`;
            });
        },
        release(delta) {
            if (moving) return;
            const direction = delta < 0 ? 1 : -1;
            const target = index + direction;
            const commit = Math.abs(delta) > innerHeight * 0.2 && Boolean(streams[target]);
            moving = true;
            slots.forEach((slot, position) => {
                slot.element.style.transition = "transform 220ms ease-out";
                const destination = commit ? (position - 1 - direction) * 100 : (position - 1) * 100;
                slot.element.style.transform = `translateY(${destination}%)`;
            });
            setTimeout(() => {
                if (!commit) {
                    resetTransforms();
                    return;
                }
                slots = direction === 1
                    ? [slots[1], slots[2], slots[0]]
                    : [slots[2], slots[0], slots[1]];
                void select(target);
            }, 230);
        },
        controls(visible) {
            controlsVisible = visible;
            updateControls();
        },
    });

    stage.addEventListener("click", async event => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button");
        if (!button) return;
        const stream = streams[index];
        if (button.classList.contains("mute")) {
            slots[1].video.muted = !slots[1].video.muted;
            void slots[1].video.play();
        } else if (button.classList.contains("follow")) {
            if (stream.isFollowing) await provider.unfollow(stream.streamerId);
            else await provider.follow(stream.streamerId);
            stream.isFollowing = !stream.isFollowing;
            persist();
        } else if (button.classList.contains("block")) {
            if (button.dataset.confirm !== "true") {
                button.dataset.confirm = "true";
                button.textContent = "❓";
                return;
            }
            if (stream.isFollowing) await provider.unfollow(stream.streamerId);
            await provider.block(stream.streamerId);
            await remove(stream.streamerId);
        } else if (button.classList.contains("download")) {
            if (downloads.has(stream.streamerId)) {
                await provider.removeFromDownloadList(stream.streamerId);
                downloads.delete(stream.streamerId);
            } else {
                await provider.addToDownloadList(stream.streamerId);
                downloads.add(stream.streamerId);
            }
        }
        updateControls();
    });

    for (const [slotIndex, slot] of slots.entries()) {
        slot.video.addEventListener("error", () => {
            if (slotIndex === 1 && slot.stream) void remove(slot.stream.streamerId);
        });
        slot.video.addEventListener("playing", () => {
            if (
                slotIndex === 1
                && slot.stream
                && slot.video.videoWidth === 0
                && slot.video.videoHeight === 0
            ) {
                void remove(slot.stream.streamerId);
            }
        });
    }

    updateSlots();
    const current = await provider.enrich(streams[index]);
    streams[index] = current;
    history.replaceState(null, "", provider.streamUrl(current.streamId));
    persist();
    updateControls();
    void discover(current);

    if (handedOff) {
        void freshStreams.then(async fresh => {
            const cachedCurrent = streams[index];
            fresh = fresh.filter(stream => !removed.has(stream.streamerId));
            let discovered: Stream[] = [];
            if (cachedCurrent?.parentStreamerId) {
                const parentIndex = fresh.findIndex(stream => stream.streamerId === cachedCurrent.parentStreamerId);
                if (parentIndex >= 0) {
                    const costreamers = await provider.fetchCostreamers(fresh[parentIndex]).catch(() => []);
                    discovered = costreamers.filter(stream => !removed.has(stream.streamerId));
                    const freshIds = new Set(fresh.map(stream => stream.streamerId));
                    fresh.splice(parentIndex + 1, 0, ...discovered.filter(stream => !freshIds.has(stream.streamerId)));
                }
            } else if (cachedCurrent && !fresh.some(stream => stream.streamerId === cachedCurrent.streamerId)) {
                discovered = (await provider.fetchCostreamers(cachedCurrent).catch(() => []))
                    .filter(stream => !removed.has(stream.streamerId));
                const freshIds = new Set(fresh.map(stream => stream.streamerId));
                fresh.unshift(...discovered.filter(stream => !freshIds.has(stream.streamerId)));
            }
            const currentId = cachedCurrent?.streamerId;
            streams.splice(0, streams.length, ...fresh);
            const freshIndex = streams.findIndex(stream => stream.streamerId === currentId);
            const costreamerIndex = discovered
                .map(stream => streams.findIndex(candidate => candidate.streamerId === stream.streamerId))
                .find(candidateIndex => candidateIndex >= 0);
            index = freshIndex >= 0 ? freshIndex : costreamerIndex ?? 0;
            if (streams[index]) await select(index);
        });
    }
}

function createSlot(position: number): Slot {
    const element = document.createElement("section");
    element.className = "stream-slot";
    element.style.transform = `translateY(${position * 100}%)`;
    const video = document.createElement("video");
    video.autoplay = position === 0;
    video.playsInline = true;
    video.muted = true;
    const controls = document.createElement("div");
    controls.className = "stream-controls";
    controls.innerHTML = `
        <p class="stream-name"></p>
        <div class="stream-progress"></div>
        <div class="stream-buttons">
            <button class="mute" title="Mute">🔇</button>
            <button class="follow" title="Follow or unfollow">🤍</button>
            <button class="block" title="Block">🚫</button>
            <button class="download" title="Download list">➕</button>
        </div>
    `;
    element.append(video, controls);
    return { element, video };
}
