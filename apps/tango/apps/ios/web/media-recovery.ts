// WebKit owns decoding and playback. Restart only a failed network load or a
// stalled playing video; keep the same element, source, mute and pause choices.
export function installMediaRecovery(live: boolean): void {
    type State = {source: string; playing: boolean; time: number; delay: number; timer?: ReturnType<typeof setTimeout>; reloading: boolean};
    const states = new WeakMap<HTMLVideoElement, State>();
    const pending = new Set<HTMLVideoElement>();
    const stateFor = (video: HTMLVideoElement): State => {
        const source = video.getAttribute('src') ?? '';
        let state = states.get(video);
        if (!state || state.source !== source) {
            if (state?.timer) clearTimeout(state.timer);
            state = {source, playing: !video.paused || video.autoplay, time: video.currentTime, delay: 1000, reloading: false};
            states.set(video, state);
        }
        return state;
    };
    const clear = (video: HTMLVideoElement, state: State) => {
        clearTimeout(state.timer); state.timer = undefined; pending.delete(video);
    };
    const retry = (video: HTMLVideoElement, state: State) => {
        clear(video, state);
        if (!video.isConnected || !state.source || video.getAttribute('src') !== state.source) return;
        if (document.hidden || !navigator.onLine) { pending.add(video); return; }
        state.reloading = true;
        video.autoplay = state.playing;
        video.load();
        if (state.playing) void video.play().catch(() => {});
    };
    const schedule = (video: HTMLVideoElement, state: State, delay = state.delay) => {
        if (state.timer) return;
        pending.add(video);
        state.timer = setTimeout(() => retry(video, state), delay);
    };
    for (const type of ['play', 'pause', 'timeupdate', 'playing', 'loadedmetadata', 'error', 'waiting', 'stalled']) {
        document.addEventListener(type, event => {
            const video = event.target;
            if (!(video instanceof HTMLVideoElement)) return;
            const state = stateFor(video);
            if (type === 'play') state.playing = true;
            if (type === 'pause' && !video.error && !state.reloading) state.playing = false;
            if (type === 'timeupdate' && !state.reloading && Number.isFinite(video.currentTime)) state.time = video.currentTime;
            if (type === 'playing') { state.playing = true; state.reloading = false; state.delay = 1000; clear(video, state); }
            if (type === 'loadedmetadata' && state.reloading) {
                if (!live && Number.isFinite(state.time) && state.time > 0) video.currentTime = state.time;
                state.reloading = false;
            }
            if (type === 'error' && (video.error?.code === MediaError.MEDIA_ERR_NETWORK || !navigator.onLine)) {
                event.stopImmediatePropagation(); // No Copy fallback or live-list removal for an outage.
                schedule(video, state); state.delay = Math.min(state.delay * 2, 30000);
            }
            if ((type === 'waiting' || type === 'stalled') && state.playing && !state.timer) {
                const time = video.currentTime;
                pending.add(video);
                state.timer = setTimeout(() => {
                    state.timer = undefined;
                    if (state.playing && video.currentTime === time && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) retry(video, state);
                    else pending.delete(video);
                }, 15000);
            }
        }, true);
    }
    const resume = () => { for (const video of [...pending]) { const state = states.get(video); if (state) retry(video, state); } };
    addEventListener('online', resume);
    addEventListener('pageshow', resume);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
    addEventListener('pagehide', () => { for (const video of pending) { const state = states.get(video); if (state) { clearTimeout(state.timer); state.timer = undefined; } } });
}
