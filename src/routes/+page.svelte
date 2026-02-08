<script lang="ts">
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import { playerStore } from '$lib/stores/player.svelte.js';
</script>

<div>
	<h1>Video Editor</h1>
	<p>Provider: {videoListStore.selectedProvider}</p>
	<p>View: {playerStore.view}</p>
	<p>Videos: {videoListStore.videos.length}</p>
</div>

<style>
	div {
		color: #fff;
		background: #000;
		min-height: 100dvh;
		padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
		font-family: -apple-system, BlinkMacSystemFont, sans-serif;
	}
</style>
