(() => {
    const catalog = JSON.parse(sessionStorage.getItem('video-catalog:tango-live') || '{"videos":[]}');
    const button = title => { const b = document.querySelector(`.buttons button[title="${title}"]`); return b ? { text: b.textContent, disabled: b.disabled, hidden: b.hidden } : null; };
    return JSON.stringify({ path: location.pathname, ready: document.readyState,
        current: document.querySelector('.streamer-name')?.textContent ?? null,
        follow: button('Follow or unfollow'), block: button('Block') || button('Tap again to block'),
        rows: catalog.videos.slice(0, 12).map(v => `${v.filename} ${v.following ? 'F' : '-'} ${v.title}`),
        result: window.__tangoTest ?? null });
})()
