<script lang="ts">
	import { goto } from '$app/navigation';
	import { PROVIDERS } from '$lib/constants.js';
	import { videoListStore } from '$lib/stores/videoList.svelte.js';

	function selectProvider(provider: string) {
		videoListStore.setProvider(provider);
		goto(`/videos/${provider}`, { replaceState: true });
	}
</script>

<div class="provider-selector">
	{#each PROVIDERS as provider}
		<button
			class="provider-btn"
			class:active={provider === videoListStore.selectedProvider}
			disabled={provider === videoListStore.selectedProvider}
			onclick={() => selectProvider(provider)}
		>
			{provider.toUpperCase()}
		</button>
	{/each}
</div>

<style>
	.provider-selector {
		display: flex;
		width: 100%;
		margin-bottom: 5px;
		border-bottom: 1px solid #444;
		padding-bottom: 5px;
		justify-content: space-around;
	}

	.provider-btn {
		background: transparent;
		border: 1px solid #555;
		color: #aaa;
		padding: 6px 12px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
		flex-grow: 1;
		margin: 0 2px;
		transition: all 0.2s ease;
	}

	.provider-btn:hover {
		background-color: rgba(255, 255, 255, 0.1);
		color: #fff;
	}

	.provider-btn.active {
		background-color: #444444;
		border-color: #444444;
		color: #fff;
		font-weight: bold;
		cursor: default;
		pointer-events: none;
	}
</style>
