<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { initAppDimensions } from '$lib/state/appDimensions';
	import { logService } from '$lib/services/LogService.js';

	let { children } = $props();

	function preventZoom(e: Event) {
		e.preventDefault();
	}

	function handleOrientationChange() {
		const viewport = document.querySelector('meta[name="viewport"]');
		if (!viewport) return;
		const content = viewport.getAttribute('content')!;
		viewport.setAttribute('content', 'width=device-width');
		setTimeout(() => {
			viewport.setAttribute('content', content);
		}, 10);
	}

	onMount(() => {
		initAppDimensions();
		logService.start();

		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js');
		}

		document.addEventListener('gesturestart', preventZoom, { passive: false });
		document.addEventListener('gesturechange', preventZoom, { passive: false });
		document.addEventListener('gestureend', preventZoom, { passive: false });

		window.addEventListener('orientationchange', handleOrientationChange);
	});

	onDestroy(() => {
		document.removeEventListener('gesturestart', preventZoom);
		document.removeEventListener('gesturechange', preventZoom);
		document.removeEventListener('gestureend', preventZoom);
		window.removeEventListener('orientationchange', handleOrientationChange);
	});
</script>

{@render children()}

<style>
	:global(body, html) {
		margin: 0;
		padding: 0;
		font-family:
			-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		background-color: #000000;
		color: #ffffff;
		-webkit-touch-callout: none;
	}

	:global(body) {
		min-height: 100dvh;
		padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
			env(safe-area-inset-left);
	}
</style>
