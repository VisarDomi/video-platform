<script lang="ts">
	import { onMount } from 'svelte';

	let { provider }: { provider: string } = $props();

	const title = $derived(`${provider.toUpperCase()} Links Editor`);

	let content = $state('');
	let status = $state('');
	let statusColor = $state('#aaa');
	let saving = $state(false);

	onMount(() => {
		loadContent();
	});

	async function loadContent() {
		try {
			const res = await fetch(`/api/${provider}`);
			if (!res.ok) throw new Error('Failed to load');
			content = await res.text();
		} catch {
			status = 'Error loading file';
			statusColor = '#ff3b30';
		}
	}

	async function saveContent() {
		saving = true;
		try {
			const res = await fetch(`/api/${provider}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content })
			});
			if (res.ok) {
				status = 'Saved at ' + new Date().toLocaleTimeString();
				statusColor = '#34c759';
				loadContent();
			} else {
				throw new Error('Save failed');
			}
		} catch {
			status = 'Error saving file';
			statusColor = '#ff3b30';
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>{title}</title>
</svelte:head>

<div class="editor">
	<div class="status" style:color={statusColor}>{status}</div>
	<textarea bind:value={content} spellcheck="false"></textarea>
	<button onclick={saveContent} disabled={saving}>
		{saving ? 'Saving...' : 'Save Changes'}
	</button>
</div>

<style>
	.editor {
		display: flex;
		flex-direction: column;
		height: 50vh;
		padding: 20px;
		box-sizing: border-box;
	}

	.status {
		height: 20px;
		font-size: 0.9rem;
		color: #aaa;
		margin-bottom: 5px;
		text-align: right;
	}

	textarea {
		flex-grow: 1;
		background-color: #1a1a1a;
		color: #e0e0e0;
		border: 1px solid #333;
		border-radius: 8px;
		padding: 15px;
		font-family: monospace;
		font-size: 16px;
		resize: none;
		outline: none;
		margin-bottom: 15px;
	}

	textarea:focus {
		border-color: #555;
	}

	button {
		background-color: #007aff;
		color: white;
		border: none;
		padding: 15px;
		font-size: 18px;
		border-radius: 12px;
		cursor: pointer;
		font-weight: bold;
	}

	button:active {
		opacity: 0.8;
	}

	button:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}
</style>
