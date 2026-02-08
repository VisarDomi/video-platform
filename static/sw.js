const CACHE_NAME = 'pwa-v1';

self.addEventListener('install', () => {
	self.skipWaiting();
});

self.addEventListener('activate', (event) => {
	event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
	// Pass through all requests to the network
	// This minimal fetch handler is required for iOS 18 PWA installability
	event.respondWith(fetch(event.request));
});
