document.addEventListener('DOMContentLoaded', () => {
    // --- DOM ELEMENTS ---
    const elements = {
        listView: document.getElementById('listView'),
        videoView: document.getElementById('videoView'),
        listContainer: document.getElementById('listContainer'),
        loadingMessage: document.getElementById('loadingMessage'),
        videoPlayer: document.getElementById('videoPlayer'),
        streamerNameEl: document.getElementById('streamerName'),
        backBtn: document.getElementById('backBtn'),
    };

    // --- ROUTER ---
    async function handleRouteChange() {
        const hash = window.location.hash || '#/archive';
        const [path, ...params] = hash.slice(2).split('/');

        // Always stop playback when navigating away from a video
        if (!path.startsWith('archive/') || params.length < 2) {
             ArchiveHandler.stopPlayback();
        }

        switch (path) {
            case 'archive':
                if (params.length >= 2) { // Play archive: #/archive/type/videoName(/time)
                    const [type, encodedName, time] = params;
                    const videoName = decodeURIComponent(encodedName);
                    const startTime = parseFloat(time) || 0;
                    ArchiveHandler.playVideoByName(type, videoName, startTime);
                } else { // Show archive list: #/archive
                    ArchiveHandler.showListPage();
                }
                break;
            default:
                window.location.hash = '#/archive';
                break;
        }
    }

    // --- EVENT LISTENERS ---
    elements.backBtn.addEventListener('click', () => {
        window.location.hash = '#/archive';
    });
    window.addEventListener('hashchange', handleRouteChange);

    // --- INITIALIZATION ---
    function initialize() {
        ArchiveHandler.init(elements);
        handleRouteChange(); // Initial route handling
    }

    initialize();
});