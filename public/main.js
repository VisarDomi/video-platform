import * as VideoHandler from './video-handler.js';

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
        const parts = hash.slice(2).split('/');
        const [type, encodedName, time] = parts;

        const isVideoRoute = (type === 'original' || type === 'edited') && encodedName;

        if (!isVideoRoute) {
            VideoHandler.stopPlayback();
        }

        if (isVideoRoute) {
            const videoName = decodeURIComponent(encodedName);
            const startTime = parseFloat(time) || 0;
            VideoHandler.playVideoByName(type, videoName, startTime);
        } else {
            VideoHandler.showListPage();
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