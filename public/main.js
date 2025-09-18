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
        const hash = window.location.hash || '#/';
        // e.g. #/original/video.mp4/123 -> ['original', 'video.mp4', '123']
        // e.g. #/ -> ['']
        const parts = hash.slice(2).split('/');
        const [type, encodedName, time] = parts;

        // A valid video route must have at least a type and a filename.
        const isVideoRoute = (type === 'original' || type === 'edited') && encodedName;

        // Always stop playback when navigating away from a video view.
        if (!isVideoRoute) {
            VideoHandler.stopPlayback();
        }

        if (isVideoRoute) {
            // Play video: #/type/videoName(/time)
            const videoName = decodeURIComponent(encodedName);
            const startTime = parseFloat(time) || 0;
            VideoHandler.playVideoByName(type, videoName, startTime);
        } else {
            // Show list page for #/, #, or any other non-video route.
            VideoHandler.showListPage();
            // Redirect malformed/old hashes to the clean root URL for consistency.
            if (location.hash !== '#/' && location.hash !== '') {
                location.hash = '#/';
            }
        }
    }

    // --- EVENT LISTENERS ---
    elements.backBtn.addEventListener('click', () => {
        window.location.hash = '#/';
    });
    window.addEventListener('hashchange', handleRouteChange);

    // --- INITIALIZATION ---
    function initialize() {
        VideoHandler.init(elements);
        handleRouteChange(); // Initial route handling
    }

    initialize();
});