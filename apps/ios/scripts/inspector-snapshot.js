JSON.stringify({
    path: location.pathname, ready: document.readyState, title: document.title,
    rows: document.querySelectorAll('a.video-row').length, error: document.querySelector('.status-error')?.textContent ?? null,
    history: history.length, scrollY,
    video: (() => { const v = document.querySelector('.current-scope video'); return v ? { ready: v.readyState, width: v.videoWidth,
        height: v.videoHeight, time: v.currentTime, paused: v.paused, error: v.error?.code ?? null } : null; })()
})
