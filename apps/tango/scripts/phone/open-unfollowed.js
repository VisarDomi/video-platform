(() => {
    const videos = JSON.parse(sessionStorage.getItem('video-catalog:tango-live')).videos;
    const target = videos.find(v => !v.following && !v.parent);
    if (!target) return JSON.stringify({ error: 'no unfollowed stream in the list', count: videos.length });
    sessionStorage.setItem('tangoBlockTarget', JSON.stringify({ id: target.filename, title: target.title, pageUrl: target.pageUrl }));
    setTimeout(() => location.assign(target.pageUrl), 100);
    return JSON.stringify({ opening: target.title, id: target.filename, pageUrl: target.pageUrl, unfollowedInList: videos.filter(v => !v.following).length });
})()
