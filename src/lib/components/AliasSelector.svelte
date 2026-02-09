<script lang="ts">
	interface Props {
		aliases: string[];
		selectedAliases: Set<string>;
		ontoggle: (alias: string) => void;
		onremove: (alias: string) => void;
	}

	let { aliases, selectedAliases, ontoggle, onremove }: Props = $props();

	let open = $state(false);
	let container = $state<HTMLElement | null>(null);

	function handleToggle(alias: string) {
		ontoggle(alias);
	}

	function handleRemove(alias: string) {
		onremove(alias);
	}

	function handleOutsideClick(e: MouseEvent) {
		if (container && !container.contains(e.target as Node)) {
			open = false;
		}
	}
</script>

<svelte:window onclick={handleOutsideClick} />

<div class="alias-selector" bind:this={container}>
	<button class="dropdown-toggle" onclick={() => (open = !open)}>
		{#if selectedAliases.size === 0}
			Select aliases...
		{:else}
			{selectedAliases.size} alias{selectedAliases.size === 1 ? '' : 'es'} selected
		{/if}
		<span class="arrow" class:open>{'\u25BC'}</span>
	</button>

	{#if open}
		<div class="dropdown-list">
			{#each aliases as alias}
				<button
					class="dropdown-item"
					class:selected={selectedAliases.has(alias)}
					onclick={() => handleToggle(alias)}
				>
					<span class="check">{selectedAliases.has(alias) ? '\u2713' : ''}</span>
					{alias}
				</button>
			{/each}
		</div>
	{/if}

	{#if selectedAliases.size > 0}
		<div class="chips">
			{#each [...selectedAliases].sort() as alias}
				<span class="chip">
					{alias}
					<button class="chip-remove" onclick={() => handleRemove(alias)}>&times;</button>
				</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.alias-selector {
		width: 100%;
		position: relative;
	}

	.dropdown-toggle {
		width: 100%;
		padding: 8px 10px;
		background: transparent;
		border: 1px solid #555;
		border-radius: 6px;
		color: #aaa;
		font-size: 14px;
		cursor: pointer;
		text-align: left;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.dropdown-toggle:hover {
		background-color: rgba(255, 255, 255, 0.05);
		color: #fff;
	}

	.arrow {
		font-size: 10px;
		transition: transform 0.2s ease;
	}

	.arrow.open {
		transform: rotate(180deg);
	}

	.dropdown-list {
		position: absolute;
		top: 100%;
		left: 0;
		right: 0;
		max-height: 200px;
		overflow-y: auto;
		background-color: rgba(30, 30, 30, 0.95);
		border: 1px solid #555;
		border-radius: 6px;
		margin-top: 2px;
		z-index: 200;
	}

	.dropdown-item {
		width: 100%;
		padding: 6px 10px;
		background: transparent;
		border: none;
		color: #ccc;
		font-size: 13px;
		cursor: pointer;
		text-align: left;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.dropdown-item:hover {
		background-color: rgba(255, 255, 255, 0.1);
		color: #fff;
	}

	.dropdown-item.selected {
		color: #fff;
	}

	.check {
		width: 14px;
		font-size: 12px;
		color: #6c6;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 6px 2px 2px;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		background-color: rgba(255, 255, 255, 0.1);
		border: 1px solid #555;
		border-radius: 12px;
		padding: 2px 8px;
		font-size: 12px;
		color: #ddd;
	}

	.chip-remove {
		background: none;
		border: none;
		color: #aaa;
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
		padding: 0 2px;
	}

	.chip-remove:hover {
		color: #fff;
	}
</style>
