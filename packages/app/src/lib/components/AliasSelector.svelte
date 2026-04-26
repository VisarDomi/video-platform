<script lang="ts">
	import { videoListStore } from '$lib/stores/videoList.svelte.js';
	import type { AliasFilterGroup } from '$lib/utils/filterGroups.js';

	const groups = $derived(videoListStore.filterGroups);
	const baseGroups = $derived(videoListStore.baseFilterGroups);
	const selectedGroups = $derived(
		groups.filter((group) =>
			group.aliases.some((alias) => videoListStore.selectedAliases.has(alias))
		)
	);
	const selectedCount = $derived(selectedGroups.length);
	const selectedVideoCount = $derived(selectedGroups.reduce((sum, group) => sum + group.count, 0));
	const managementRows = $derived.by(() => {
		if (!managementGroup) return [];
		const activeGroup = managementGroup;
		const query = managementSearch.trim().toLowerCase();
		const rows = baseGroups.filter((group) => {
			if (group.id === activeGroup.id) return false;
			if (videoListStore.areManuallyLinked(activeGroup, group)) return true;
			if (!query) return true;
			return group.aliases.some((alias) => alias.toLowerCase().includes(query));
		});
		return rows.sort((a, b) => {
			const aLinked = videoListStore.areManuallyLinked(activeGroup, a);
			const bLinked = videoListStore.areManuallyLinked(activeGroup, b);
			if (aLinked !== bLinked) return aLinked ? -1 : 1;
			return b.count - a.count || a.label.localeCompare(b.label);
		});
	});

	let open = $state(false);
	let managementGroup = $state<AliasFilterGroup | null>(null);
	let managementSearch = $state('');
	let container = $state<HTMLElement | null>(null);
	let longPressTimer: number | null = null;
	let suppressClick = false;

	function handleOutsideClick(e: MouseEvent) {
		if (container && !container.contains(e.target as Node)) {
			open = false;
		}
	}

	function formatGroupName(group: AliasFilterGroup): string {
		if (group.aliases.length === 1) return group.label;
		return `${group.label} +${group.aliases.length - 1}`;
	}

	function isSelected(group: AliasFilterGroup): boolean {
		return group.aliases.some((alias) => videoListStore.selectedAliases.has(alias));
	}

	function startLongPress(group: AliasFilterGroup) {
		cancelLongPress();
		suppressClick = false;
		longPressTimer = window.setTimeout(() => {
			suppressClick = true;
			openManagement(group);
		}, 550);
	}

	function cancelLongPress() {
		if (longPressTimer !== null) {
			window.clearTimeout(longPressTimer);
			longPressTimer = null;
		}
	}

	function handleGroupClick(group: AliasFilterGroup) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		videoListStore.toggleFilterGroup(group);
	}

	function openManagement(group: AliasFilterGroup) {
		cancelLongPress();
		managementGroup = getBaseGroup(group);
		managementSearch = '';
	}

	function closeManagement() {
		managementGroup = null;
		managementSearch = '';
	}

	function getBaseGroup(group: AliasFilterGroup): AliasFilterGroup {
		const aliases = new Set(group.aliases);
		return (
			baseGroups.find((baseGroup) => baseGroup.aliases.some((alias) => aliases.has(alias))) || group
		);
	}

	function toggleCandidate(candidate: AliasFilterGroup) {
		if (!managementGroup) return;
		videoListStore.toggleManualLink(managementGroup, candidate);
	}
</script>

<svelte:window onclick={handleOutsideClick} />

<div class="alias-selector" bind:this={container}>
	<button class="dropdown-toggle" onclick={() => (open = !open)}>
		{#if selectedCount === 0}
			Select filters...
		{:else}
			{selectedCount} filter{selectedCount === 1 ? '' : 's'} ({selectedVideoCount})
		{/if}
		<span class="arrow" class:open>{'\u25BC'}</span>
	</button>

	{#if open}
		<div class="dropdown-list">
			{#each groups as group (group.id)}
				<button
					class="dropdown-item"
					class:selected={isSelected(group)}
					onclick={() => handleGroupClick(group)}
					oncontextmenu={(event) => {
						event.preventDefault();
						openManagement(group);
					}}
					onpointerdown={() => startLongPress(group)}
					onpointerup={cancelLongPress}
					onpointercancel={cancelLongPress}
					onpointerleave={cancelLongPress}
				>
					<span class="check">{isSelected(group) ? '\u2713' : ''}</span>
					<span class="filter-name">{formatGroupName(group)}</span>
					<span class="count">({group.count})</span>
				</button>
			{/each}
		</div>
	{/if}

	{#if selectedGroups.length > 0}
		<div class="chips">
			{#each selectedGroups as group (group.id)}
				<span class="chip">
					{formatGroupName(group)} <span class="count">({group.count})</span>
					<button class="chip-remove" onclick={() => videoListStore.removeFilterGroup(group)}
						>&times;</button
					>
				</span>
			{/each}
		</div>
	{/if}
</div>

{#if managementGroup}
	<div class="modal-layer">
		<button class="modal-backdrop" aria-label="Close filter management" onclick={closeManagement}
		></button>
		<div class="management-modal" role="dialog" aria-modal="true">
			<div class="modal-header">
				<div class="modal-title">{managementGroup.label}</div>
				<button class="icon-button" onclick={closeManagement}>&times;</button>
			</div>

			<div class="linked-list">
				{#each managementGroup.aliases as alias}
					<div class="linked-item">
						<span>{alias}</span>
						<button
							class="text-button"
							disabled={managementGroup.aliases.length === 1}
							onclick={() => {
								if (!managementGroup) return;
								videoListStore.unlinkAliasFromGroup(managementGroup, alias);
							}}
						>
							Unlink
						</button>
					</div>
				{/each}
			</div>

			<input class="search-input" bind:value={managementSearch} placeholder="Search filters" />

			<div class="candidate-list">
				{#each managementRows as candidate (candidate.id)}
					<button
						class="candidate-item"
						class:linked={videoListStore.areManuallyLinked(managementGroup, candidate)}
						onclick={() => toggleCandidate(candidate)}
					>
						<span>{formatGroupName(candidate)}</span>
						<span class="candidate-meta">
							{#if videoListStore.areManuallyLinked(managementGroup, candidate)}
								Linked
							{/if}
							<span class="count">({candidate.count})</span>
						</span>
					</button>
				{/each}
			</div>

			<div class="modal-footer">
				<button class="dismiss-button" onclick={closeManagement}>Dismiss</button>
			</div>
		</div>
	</div>
{/if}

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

	.filter-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
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

	.count {
		color: #888;
		font-size: 0.9em;
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

	.modal-layer {
		position: fixed;
		inset: 0;
		z-index: 500;
		display: flex;
		align-items: center;
		justify-content: center;
		box-sizing: border-box;
		padding: calc(env(safe-area-inset-top) + 18px) 18px calc(env(safe-area-inset-bottom) + 18px);
	}

	.modal-backdrop {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.64);
		border: none;
		padding: 0;
		cursor: default;
	}

	.management-modal {
		position: relative;
		width: min(520px, 100%);
		max-height: min(
			620px,
			calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 36px)
		);
		background: #181818;
		border: 1px solid #555;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 12px;
		border-bottom: 1px solid #333;
	}

	.modal-title {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 14px;
		font-weight: 600;
		color: #fff;
	}

	.icon-button,
	.text-button {
		background: transparent;
		border: 1px solid #555;
		color: #ddd;
		cursor: pointer;
	}

	.icon-button {
		width: 30px;
		height: 30px;
		border-radius: 6px;
		font-size: 20px;
		line-height: 1;
	}

	.text-button {
		border-radius: 6px;
		padding: 4px 8px;
		font-size: 12px;
	}

	.text-button:disabled {
		opacity: 0.35;
		cursor: default;
	}

	.linked-list {
		padding: 8px 12px;
		display: flex;
		flex-direction: column;
		gap: 6px;
		border-bottom: 1px solid #333;
	}

	.linked-item,
	.candidate-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		min-height: 32px;
	}

	.linked-item span,
	.candidate-item span:first-child {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.search-input {
		margin: 10px 12px;
		padding: 8px 10px;
		background: #101010;
		border: 1px solid #555;
		border-radius: 6px;
		color: #fff;
		font-size: 14px;
	}

	.candidate-list {
		overflow-y: auto;
		padding: 0 6px 8px;
	}

	.candidate-item {
		width: 100%;
		padding: 7px 8px;
		background: transparent;
		border: none;
		color: #ddd;
		cursor: pointer;
		text-align: left;
		border-radius: 6px;
	}

	.candidate-item:hover,
	.candidate-item.linked,
	.icon-button:hover,
	.text-button:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.08);
		color: #fff;
	}

	.candidate-meta {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: #8f8;
		font-size: 12px;
	}

	.modal-footer {
		padding: 10px 12px;
		border-top: 1px solid #333;
		display: flex;
		justify-content: flex-end;
	}

	.dismiss-button {
		min-width: 92px;
		min-height: 36px;
		border: 1px solid #666;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.08);
		color: #fff;
		cursor: pointer;
		font-size: 14px;
	}

	.dismiss-button:hover {
		background: rgba(255, 255, 255, 0.14);
	}
</style>
