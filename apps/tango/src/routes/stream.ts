import { isPageReload, loadState, saveState } from "../core/state";
import { appendPages } from "../core/pagination";
import type { Provider, Stream } from "../provider";
import { streamLabel } from "./home";
import { attachGestures } from "../ui/gestures";

interface Slot {
    element: HTMLElement;
    video: HTMLVideoElement;
    generation: number;
    loaded?: boolean;
    stream?: Stream;
    quality?: string;
    error?: string;
}

const GEOMETRY_WAIT_MS = 8000;
const MULTIPLE_VIDEOS_KEY = "stream-viewer-multiple-videos";

async function bestEffortCostreamers(provider: Provider, stream: Stream): Promise<Stream[]> {
    try {
        return await provider.fetchCostreamers?.(stream) ?? [];
    } catch (error) {
        console.warn(`Could not refresh co-streamers for ${stream.streamerId}`, error);
        return [];
    }
}

export async function openStream(provider: Provider, requestedStreamId: string): Promise<void> {
    const shared = loadState();
    const handedOff = !isPageReload()
        && shared?.streams.some(stream => stream.streamId === requestedStreamId) === true;
    const streams = handedOff ? [...shared.streams] : await provider.fetchStreams();
    let nextPage = handedOff ? shared.nextPage : undefined;
    let stopPages = () => {};
    const cachedCurrent = shared?.streams.find(stream => stream.streamId === requestedStreamId);
    if (!handedOff && cachedCurrent?.parentStreamerId
        && !streams.some(stream => stream.streamerId === cachedCurrent.streamerId)) {
        const parent = streams.find(stream => stream.streamerId === cachedCurrent.parentStreamerId);
        if (parent) {
            for (const costreamer of await bestEffortCostreamers(provider, parent)) {
                if (!streams.some(stream => stream.streamerId === costreamer.streamerId)) streams.push(costreamer);
            }
        }
    }
    let index = streams.findIndex(stream => stream.streamId === requestedStreamId);
    if (index < 0 && cachedCurrent) index = streams.findIndex(stream => stream.streamerId === cachedCurrent.streamerId);
    if (index < 0 && provider.playback === "video") {
        throw new Error("This video is not in your uploads. Open your uploads list to refresh it.");
    }
    if (index < 0) index = 0;
    if (!streams[index]) {
        saveState({ streams, currentStreamerId: "" });
        throw new Error(provider.playback === "video" ? "No uploads are available." : "No live streams are available.");
    }

    document.body.replaceChildren();
    document.body.className = "stream-page";
    history.scrollRestoration = "manual";
    const stage = document.createElement("main");
    stage.className = "stream-stage viewer-loading";
    const controls = createControls(provider);
    document.body.append(stage, controls);

    let slots = [-1, 0, 1].map(() => createSlot());
    let multipleVideos = localStorage.getItem(MULTIPLE_VIDEOS_KEY) !== "off";
    applyScopeRoles();
    let controlsVisible = true;
    let navigating = false;
    let programmaticScroll = false;
    let touching = false;
    let scrollFinished = true;
    let layoutOffset = 0;
    let lastScrollY = window.scrollY;
    let scrollDirection: -1 | 0 | 1 = 0;
    const removing = new Set<string>();
    const removed = new Set<string>();
    const processedForCostreamers = new Set<string>();
    let downloads: Set<string> | null = null;
    let downloadStatus: "loading" | "ready" | "error" = "loading";
    let downloadPending = false;
    let downloadError = "";
    void provider.fetchDownloadList?.().then(result => {
        downloads = result;
        downloadStatus = "ready";
        updateControls();
    }).catch(error => {
        downloadStatus = "error";
        downloadError = error instanceof Error ? error.message : String(error);
        updateControls();
    });

    function adjacent(offset: number): Stream | undefined {
        return streams[index + offset];
    }

    function setSlot(slot: Slot, stream: Stream | undefined): void {
        const load = !!stream && (multipleVideos || slot === slots[1]);
        if (slot.stream?.streamerId === stream?.streamerId && slot.loaded === load) return;
        const generation = ++slot.generation;
        slot.stream = stream;
        slot.loaded = load;
        slot.quality = undefined;
        slot.error = undefined;
        slot.video.pause();
        slot.video.removeAttribute("src");
        slot.video.load();
        slot.video.hidden = !stream;
        // Keep the swipe geometry and entry identity without loading media.
        slot.video.style.visibility = load ? "" : "hidden";
        if (!stream || !load) return;
        slot.video.muted = true;
        if (provider.resolvePlayback) {
            void provider.resolvePlayback(stream).then(source => {
                if (slot.generation !== generation) return;
                slot.quality = source.quality;
                slot.video.src = source.url;
                slot.video.load();
                if (multipleVideos || slot === slots[1]) void slot.video.play().catch(() => undefined);
                updateControls();
            }).catch(error => {
                if (slot.generation !== generation) return;
                slot.error = error instanceof Error ? error.message : "Unable to load video.";
                updateControls();
            });
        } else {
            slot.video.src = stream.masterListUrl;
            slot.video.load();
            void slot.video.play().catch(() => undefined);
        }
    }

    function updateSlots(): void {
        slots.forEach((slot, position) => {
            setSlot(slot, adjacent(position - 1));
            if (!slot.loaded) return;
            slot.video.muted = true;
            if (multipleVideos || position === 1) {
                if (slot.video.getAttribute("src")) void slot.video.play().catch(() => undefined);
            } else {
                slot.video.pause();
            }
        });
        updateControls();
    }

    function persist(): void {
        saveState({ streams, nextPage, currentStreamerId: streams[index].streamerId });
    }

    function syncMultipleVideos(): void {
        multipleVideos = localStorage.getItem(MULTIPLE_VIDEOS_KEY) !== "off";
        slots.forEach((slot, position) => setSlot(slot, adjacent(position - 1)));
        updateControls();
    }

    function resumePages(): void {
        stopPages();
        if (document.hidden) return;
        stopPages = appendPages(provider, streams, nextPage, (_added, cursor) => {
            nextPage = cursor;
            persist();
            // Only fill newly available neighbors; do not unpause or mute the
            // current video when another uploads page arrives.
            slots.forEach((slot, position) => setSlot(slot, adjacent(position - 1)));
            updateControls();
        }, () => {});
    }

    function updateControls(): void {
        const stream = streams[index];
        if (!stream) return;
        document.title = stream.alias || stream.firstName;
        controls.classList.toggle("hidden", !controlsVisible);
        controls.querySelector<HTMLElement>(".stream-name")!.textContent =
            streamLabel(provider, stream);
        if (provider.playback === "video") {
            const current = slots[1];
            controls.querySelector<HTMLElement>(".playback-status")!.textContent =
                current.error || current.quality || "Loading highest quality…";
            controls.querySelector<HTMLButtonElement>(".retry")!.hidden = !current.error;
            controls.querySelector<HTMLButtonElement>(".play-pause")!.textContent = current.video.paused ? "▶" : "⏸";
        }
        const mute = controls.querySelector<HTMLButtonElement>(".mute")!;
        mute.textContent = slots[1].video.muted ? "🔇" : "🔊";
        const multiple = controls.querySelector<HTMLButtonElement>(".multiple-videos")!;
        multiple.textContent = multipleVideos ? "Multi: On" : "Multi: Off";
        multiple.setAttribute("aria-pressed", String(multipleVideos));
        const follow = controls.querySelector<HTMLButtonElement>(".follow")!;
        follow.textContent = stream.isFollowing ? "❤️" : "🤍";
        follow.classList.toggle("remove", stream.isFollowing);
        const block = controls.querySelector<HTMLButtonElement>(".block")!;
        block.dataset.confirm = "false";
        block.textContent = "🚫";
        const download = controls.querySelector<HTMLButtonElement>(".download")!;
        download.classList.remove("add", "remove", "error");
        download.title = "Download list";
        if (downloadPending || downloadStatus === "loading") {
            download.textContent = "⏳";
            download.disabled = true;
        } else if (downloadStatus === "error" || downloads === null) {
            download.textContent = "⚠️";
            download.disabled = true;
            download.classList.add("error");
            download.title = downloadError;
        } else {
            const downloaded = downloads.has(stream.streamerId);
            download.textContent = downloaded ? "➖" : "➕";
            download.disabled = false;
            download.classList.add(downloaded ? "remove" : "add");
            if (downloadError) {
                download.classList.add("error");
                download.title = downloadError;
            }
        }
    }

    async function discover(stream: Stream): Promise<void> {
        if (!provider.fetchCostreamers || stream.parentStreamerId || processedForCostreamers.has(stream.streamerId)) return;
        let additions: Stream[];
        try {
            additions = await provider.fetchCostreamers(stream);
        } catch (error) {
            console.warn(`Could not discover co-streamers for ${stream.streamerId}`, error);
            return;
        }
        processedForCostreamers.add(stream.streamerId);
        const available = additions.filter(item => !removed.has(item.streamerId));
        if (!available.length) return;
        if (!streams.some(item => item.streamerId === stream.streamerId)) return;
        for (const addition of available) {
            if (!streams.some(item => item.streamerId === addition.streamerId)) streams.push(addition);
        }
        persist();
        updateSlots();
    }

    async function select(nextIndex: number): Promise<void> {
        if (!streams[nextIndex]) {
            return;
        }
        index = nextIndex;
        updateSlots();
        history.replaceState(null, "", provider.streamUrl(streams[index].streamId));
        persist();
        updateControls();
        const current = await provider.enrich(streams[index]);
        if (streams[index]?.streamerId !== current.streamerId) return;
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
        streams.splice(failedIndex, 1);
        if (!streams.length) {
            saveState({ streams, currentStreamerId: "" });
            document.body.replaceChildren();
            const message = document.createElement("p");
            message.className = "status";
            message.textContent = "No live streams are available.";
            document.body.append(message);
            removing.delete(streamerId);
            return;
        }
        if (failedIndex < index) index--;
        else if (index >= streams.length) index = streams.length - 1;
        await select(index);
        removing.delete(streamerId);
    }

    function applyScopeRoles(): void {
        slots.forEach((slot, position) => {
            slot.element.classList.remove("previous-scope", "current-scope", "next-scope");
            slot.element.classList.add(
                position === 0 ? "previous-scope" : position === 1 ? "current-scope" : "next-scope",
            );
            stage.append(slot.element);
        });
    }

    function beginNavigating(): void {
        if (navigating) return;
        navigating = true;
        lastScrollY = window.scrollY;
        scrollDirection = 0;
        stage.classList.add("viewer-navigating");
        controls.classList.add("unsettled");
    }

    function settleNavigation(): void {
        if (!navigating || touching || !scrollFinished || !stage.isConnected) return;
        // Keep a video already under the midpoint. A spacer landing advances
        // only one adjacent entry in the last scroll direction, never a jump
        // proportional to the distance travelled through the 10k runway.
        const midpoint = viewportMidpoint();
        const winner = slotAtMidpoint(midpoint);
        if (winner !== -1 && winner !== 1) {
            commitScope(winner === 0 ? -1 : 1);
        } else if (winner === -1 && scrollDirection !== 0) {
            commitScope(scrollDirection);
        }
        const rect = slots[1].video.getBoundingClientRect();
        const outside = midpoint < rect.top || midpoint >= rect.bottom;
        const desiredTop = outside ? midpoint - rect.height / 2 : rect.top;
        navigating = false;
        stage.classList.remove("viewer-navigating");
        controls.classList.remove("unsettled");
        layoutOffset = 0;
        stage.style.removeProperty('transform');
        // Momentum is now over. Rebase the virtual layout without moving the
        // visible video; only spacer landings are brought back to its center.
        correctScroll(slots[1].video.getBoundingClientRect().top - desiredTop);
    }

    function viewportMidpoint(): number {
        return visualViewport
            ? visualViewport.offsetTop + visualViewport.height / 2
            : innerHeight / 2;
    }

    function slotAtMidpoint(midpoint: number): number {
        return slots.findIndex(slot => {
            if (!slot.stream || slot.video.hidden) return false;
            const rect = slot.video.getBoundingClientRect();
            return rect.top <= midpoint && midpoint < rect.bottom;
        });
    }

    function commitMidpointStream(): void {
        if (!navigating) return;
        const winner = slotAtMidpoint(viewportMidpoint());
        if (winner === -1 || winner === 1) return;
        commitScope(winner === 0 ? -1 : 1);
    }

    function commitScope(direction: -1 | 1): void {
        const target = index + direction;
        if (!streams[target]) return;
        const selected = direction === 1 ? slots[2] : slots[0];
        const beforeTop = selected.video.getBoundingClientRect().top;
        slots = direction === 1
            ? [slots[1], slots[2], slots[0]]
            : [slots[2], slots[0], slots[1]];
        applyScopeRoles();
        const afterTop = slots[1].video.getBoundingClientRect().top;
        // Recycling must not write scroll position while iOS owns momentum.
        // Offset layout instead, keeping the selected video at the same screen
        // position. The offset is normalized once the gesture actually settles.
        layoutOffset += beforeTop - afterTop;
        stage.style.transform = `translateY(${layoutOffset}px)`;
        void select(target);
    }

    function correctScroll(delta: number): void {
        if (Math.abs(delta) < 0.5) return;
        programmaticScroll = true;
        window.scrollBy(0, delta);
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                programmaticScroll = false;
            });
        });
    }

    attachGestures(stage, {
        contact(active) {
            touching = active;
            if (!active) settleNavigation();
        },
        verticalStart: beginNavigating,
        controls(visible) {
            controlsVisible = visible;
            updateControls();
        },
    });

    window.addEventListener("scroll", () => {
        if (programmaticScroll) return;
        const delta = window.scrollY - lastScrollY;
        if (Math.abs(delta) >= 0.5) scrollDirection = delta > 0 ? 1 : -1;
        lastScrollY = window.scrollY;
        scrollFinished = false;
        commitMidpointStream();
    }, { passive: true });
    window.addEventListener("scrollend", () => {
        if (programmaticScroll) return;
        scrollFinished = true;
        settleNavigation();
    });

    window.addEventListener('pagehide', () => {
        touching = false;
        stopPages();
    });
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        syncMultipleVideos();
        const latest = loadState();
        if (provider.fetchStreamPage && latest?.streams.length) {
            const selected = streams[index].streamerId;
            streams.splice(0, streams.length, ...latest.streams);
            index = Math.max(0, streams.findIndex(stream => stream.streamerId === selected));
            nextPage = latest.nextPage;
            slots.forEach((slot, position) => setSlot(slot, adjacent(position - 1)));
            history.replaceState(null, "", provider.streamUrl(streams[index].streamId));
            persist();
            updateControls();
            resumePages();
        }
        scrollFinished = true;
        settleNavigation();
    });
    window.addEventListener('storage', event => {
        if (event.key === MULTIPLE_VIDEOS_KEY || event.key === null) syncMultipleVideos();
    });
    if (provider.fetchStreamPage) document.addEventListener('visibilitychange', () => {
        if (document.hidden) stopPages();
        else resumePages();
    });

    controls.addEventListener("click", async event => {
        const button = (event.target as Element).closest<HTMLButtonElement>("button");
        if (!button) return;
        const stream = streams[index];
        if (button.classList.contains("multiple-videos")) {
            localStorage.setItem(MULTIPLE_VIDEOS_KEY, multipleVideos ? "off" : "on");
            syncMultipleVideos();
        } else if (button.classList.contains("retry")) {
            const current = slots[1].stream;
            slots[1].stream = undefined;
            setSlot(slots[1], current);
        } else if (button.classList.contains("play-pause")) {
            if (slots[1].video.paused) await slots[1].video.play().catch(() => undefined);
            else slots[1].video.pause();
        } else if (button.classList.contains("mute")) {
            slots[1].video.muted = !slots[1].video.muted;
            void slots[1].video.play();
        } else if (button.classList.contains("follow")) {
            if (stream.isFollowing) await provider.unfollow?.(stream.streamerId);
            else await provider.follow?.(stream.streamerId);
            stream.isFollowing = !stream.isFollowing;
            persist();
        } else if (button.classList.contains("block")) {
            if (button.dataset.confirm !== "true") {
                button.dataset.confirm = "true";
                button.textContent = "❓";
                return;
            }
            if (stream.isFollowing) await provider.unfollow?.(stream.streamerId);
            await provider.block?.(stream.streamerId);
            await remove(stream.streamerId);
        } else if (button.classList.contains("download")) {
            if (downloadStatus !== "ready" || downloads === null || downloadPending) return;
            const downloaded = downloads.has(stream.streamerId);
            downloadPending = true;
            downloadError = "";
            updateControls();
            try {
                if (downloaded) {
                    await provider.removeFromDownloadList?.(stream.streamerId);
                    downloads.delete(stream.streamerId);
                } else {
                    await provider.addToDownloadList?.(stream.streamerId);
                    downloads.add(stream.streamerId);
                }
            } catch (error) {
                downloadError = error instanceof Error ? error.message : String(error);
            } finally {
                downloadPending = false;
            }
        }
        updateControls();
    });

    const seek = controls.querySelector<HTMLInputElement>(".seek");
    seek?.addEventListener("input", () => {
        const video = slots[1].video;
        if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = Number(seek.value) / 1000 * video.duration;
    });
    for (const slot of slots) {
        if (provider.playback === "video") {
            slot.video.preload = "metadata";
            for (const event of ["timeupdate", "durationchange", "play", "pause", "ended"]) {
                slot.video.addEventListener(event, () => {
                    if (slot !== slots[1]) return;
                    const duration = slot.video.duration;
                    if (seek) {
                        seek.disabled = !Number.isFinite(duration) || duration <= 0;
                        seek.value = seek.disabled ? "0" : String(slot.video.currentTime / duration * 1000);
                    }
                    updateControls();
                });
            }
        }
        slot.video.addEventListener("error", () => {
            if (provider.playback === "video") {
                slot.error = "Playback failed. Retry to refresh the highest-quality source.";
                updateControls();
            } else if (slot === slots[1] && slot.stream) void remove(slot.stream.streamerId);
        });
        slot.video.addEventListener("playing", () => {
            if (
                provider.playback === "live"
                && slot === slots[1]
                && slot.stream
                && slot.video.videoWidth === 0
                && slot.video.videoHeight === 0
            ) {
                void remove(slot.stream.streamerId);
            }
        });
    }

    updateSlots();
    resumePages();
    const current = await provider.enrich(streams[index]);
    streams[index] = current;
    history.replaceState(null, "", provider.streamUrl(current.streamId));
    persist();
    updateControls();
    void discover(current);
    await revealWhenCurrentGeometryIsReady(slots[1].video, stage);
}

function createSlot(): Slot {
    const element = document.createElement("section");
    element.className = "stream-slot";
    const video = document.createElement("video");
    video.playsInline = true;
    video.preload = "auto";
    video.muted = true;
    element.append(video);
    return { element, video, generation: 0 };
}

function createControls(provider: Provider): HTMLDivElement {
    const controls = document.createElement("div");
    controls.className = "stream-controls";
    controls.innerHTML = `
        <p class="stream-name"></p>
        <div class="stream-progress"></div>
        <div class="stream-buttons">
            <button class="mute" title="Mute">🔇</button>
            <button class="multiple-videos" title="Load and play neighboring videos" aria-pressed="true">Multi: On</button>
            <button class="follow" title="Follow or unfollow">🤍</button>
            <button class="block" title="Block">🚫</button>
            <button class="download" title="Download list">➕</button>
        </div>
    `;
    controls.querySelector<HTMLButtonElement>(".follow")!.hidden = !provider.follow || !provider.unfollow;
    controls.querySelector<HTMLButtonElement>(".block")!.hidden = !provider.block;
    controls.querySelector<HTMLButtonElement>(".download")!.hidden = !provider.fetchDownloadList;
    if (provider.playback === "video") {
        controls.querySelector(".stream-progress")!.outerHTML = `
            <p class="playback-status" role="status"></p>
            <input class="seek" type="range" min="0" max="1000" value="0" aria-label="Seek video" disabled>
        `;
        controls.querySelector(".stream-buttons")!.insertAdjacentHTML("afterbegin", `
            <button class="play-pause" title="Play or pause">▶</button>
            <button class="retry" title="Retry playback" hidden>↻</button>
        `);
    }
    return controls;
}

async function revealWhenCurrentGeometryIsReady(
    video: HTMLVideoElement,
    stage: HTMLElement,
): Promise<void> {
    if (video.videoWidth === 0 || video.videoHeight === 0) {
        await new Promise<void>(resolve => {
            let timeout = 0;
            const finish = () => {
                clearTimeout(timeout);
                video.removeEventListener("resize", ready);
                video.removeEventListener("loadedmetadata", ready);
                video.removeEventListener("error", finish);
                resolve();
            };
            const ready = () => {
                if (video.videoWidth > 0 && video.videoHeight > 0) finish();
            };
            video.addEventListener("resize", ready);
            video.addEventListener("loadedmetadata", ready);
            video.addEventListener("error", finish, { once: true });
            timeout = window.setTimeout(finish, GEOMETRY_WAIT_MS);
        });
    }
    const viewportCenter = visualViewport
        ? visualViewport.offsetTop + visualViewport.height / 2
        : innerHeight / 2;
    const rect = video.getBoundingClientRect();
    window.scrollBy(0, rect.top + rect.height / 2 - viewportCenter);
    stage.classList.remove("viewer-loading");
}
