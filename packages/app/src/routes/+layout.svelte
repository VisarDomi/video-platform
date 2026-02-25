<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	let { children } = $props();

	function preventZoom(e: Event) {
		e.preventDefault();
	}

	onMount(() => {
		if ('serviceWorker' in navigator) {
			navigator.serviceWorker.register('/sw.js');
		}

		// Prevent Safari pinch-zoom gestures
		document.addEventListener('gesturestart', preventZoom, { passive: false });
		document.addEventListener('gesturechange', preventZoom, { passive: false });
		document.addEventListener('gestureend', preventZoom, { passive: false });
	});

	onDestroy(() => {
		document.removeEventListener('gesturestart', preventZoom);
		document.removeEventListener('gesturechange', preventZoom);
		document.removeEventListener('gestureend', preventZoom);
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
