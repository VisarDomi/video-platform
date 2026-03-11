<script lang="ts">
	import { onMount } from 'svelte';
	import { PROVIDER_IDS, PROVIDER_META, type ProviderId, type MonthReport, type AliasReport } from '$lib/types';

	let activeProvider: ProviderId = $state('tango');
	let months: string[] = $state([]);
	let selectedMonth = $state('');
	let report: MonthReport | null = $state(null);
	let loading = $state(false);
	let sortKey: keyof AliasReport = $state('downloadedGB');
	let sortAsc = $state(false);
	let snapshotMsg = $state('');

	const accent = $derived(PROVIDER_META[activeProvider].accent);

	const sortedAliases = $derived(
		report
			? [...report.aliases].sort((a, b) => {
					const av = a[sortKey];
					const bv = b[sortKey];
					if (typeof av === 'number' && typeof bv === 'number') {
						return sortAsc ? av - bv : bv - av;
					}
					return sortAsc
						? String(av).localeCompare(String(bv))
						: String(bv).localeCompare(String(av));
				})
			: []
	);

	const maxDownloaded = $derived(
		report ? Math.max(...report.aliases.map((a) => a.downloadedGB), 1) : 1
	);

	async function switchProvider(id: ProviderId) {
		report = null;
		months = [];
		selectedMonth = '';
		snapshotMsg = '';
		activeProvider = id;
		await loadMonths();
	}

	async function loadMonths() {
		const res = await fetch(`/api/${activeProvider}/months`);
		months = await res.json();
		if (months.length > 0 && !selectedMonth) {
			selectedMonth = months[0];
			await loadReport();
		}
	}

	async function loadReport() {
		if (!selectedMonth) return;
		loading = true;
		const res = await fetch(`/api/${activeProvider}/report/${selectedMonth}`);
		report = await res.json();
		loading = false;
	}

	async function loadLive() {
		if (!selectedMonth) return;
		loading = true;
		const res = await fetch(`/api/${activeProvider}/report/${selectedMonth}/live`);
		report = await res.json();
		loading = false;
	}

	async function saveSnapshot() {
		if (!selectedMonth) return;
		const res = await fetch(`/api/${activeProvider}/snapshot/${selectedMonth}`, { method: 'POST' });
		const data = await res.json();
		if (data.saved) {
			snapshotMsg = `Snapshot saved for ${selectedMonth}`;
			setTimeout(() => (snapshotMsg = ''), 3000);
		}
	}

	function setSort(key: keyof AliasReport) {
		if (sortKey === key) {
			sortAsc = !sortAsc;
		} else {
			sortKey = key;
			sortAsc = key === 'alias';
		}
	}

	function sortIndicator(key: keyof AliasReport): string {
		if (sortKey !== key) return '';
		return sortAsc ? ' \u25B2' : ' \u25BC';
	}

	function formatGB(gb: number): string {
		return gb >= 1 ? gb.toFixed(2) : gb >= 0.01 ? gb.toFixed(2) : '<0.01';
	}

	onMount(() => loadMonths());
</script>

<div class="dashboard">
	<header>
		<nav class="provider-tabs">
			{#each PROVIDER_IDS as id}
				<button
					class="tab"
					class:active={activeProvider === id}
					style={activeProvider === id ? `border-color: ${PROVIDER_META[id].accent}; color: ${PROVIDER_META[id].accent}` : ''}
					onclick={() => switchProvider(id)}
				>
					{PROVIDER_META[id].label}
				</button>
			{/each}
		</nav>
		<div class="controls">
			<select bind:value={selectedMonth} onchange={loadReport}>
				{#each months as m}
					<option value={m}>{m}</option>
				{/each}
			</select>
			<button onclick={loadReport} disabled={loading}>
				{loading ? 'Loading...' : 'Refresh'}
			</button>
			{#if report?.fromSnapshot}
				<button onclick={loadLive} disabled={loading}>Load Live</button>
			{/if}
			<button onclick={saveSnapshot} disabled={loading || !report}>Save Snapshot</button>
			{#if snapshotMsg}
				<span class="snapshot-msg">{snapshotMsg}</span>
			{/if}
		</div>
	</header>

	{#if report}
		<div class="summary">
			<div class="stat">
				<span class="stat-value">{report.totalDownloadedGB.toFixed(1)} GB</span>
				<span class="stat-label">Downloaded</span>
			</div>
			<div class="stat">
				<span class="stat-value">{report.totalEditedGB.toFixed(1)} GB</span>
				<span class="stat-label">Edited</span>
			</div>
			<div class="stat">
				<span class="stat-value">{report.overallEditPercent}%</span>
				<span class="stat-label">Edit Rate</span>
			</div>
			<div class="stat">
				<span class="stat-value">{report.totalDownloadedCount}</span>
				<span class="stat-label">DL Folders</span>
			</div>
			<div class="stat">
				<span class="stat-value">{report.totalEditedCount}</span>
				<span class="stat-label">Edit Folders</span>
			</div>
			<div class="stat">
				<span class="stat-value">{report.aliases.length}</span>
				<span class="stat-label">Aliases</span>
			</div>
			{#if report.fromSnapshot}
				<div class="stat snapshot-badge">
					<span class="stat-value">Snapshot</span>
					<span class="stat-label">{new Date(report.generatedAt).toLocaleDateString()}</span>
				</div>
			{/if}
		</div>

		<table>
			<thead>
				<tr>
					<th class="col-rank">#</th>
					<th class="col-alias sortable" onclick={() => setSort('alias')}>
						Alias{sortIndicator('alias')}
					</th>
					<th class="col-num sortable" onclick={() => setSort('downloadedGB')}>
						DL (GB){sortIndicator('downloadedGB')}
					</th>
					<th class="col-bar">Distribution</th>
					<th class="col-num sortable" onclick={() => setSort('downloadedCount')}>
						DL #{sortIndicator('downloadedCount')}
					</th>
					<th class="col-num sortable" onclick={() => setSort('editedGB')}>
						Edit (GB){sortIndicator('editedGB')}
					</th>
					<th class="col-num sortable" onclick={() => setSort('editedCount')}>
						Edit #{sortIndicator('editedCount')}
					</th>
					<th class="col-num sortable" onclick={() => setSort('editPercent')}>
						Edit %{sortIndicator('editPercent')}
					</th>
				</tr>
			</thead>
			<tbody>
				{#each sortedAliases as alias, i}
					<tr>
						<td class="col-rank">{i + 1}</td>
						<td class="col-alias">{alias.alias}</td>
						<td class="col-num">{formatGB(alias.downloadedGB)}</td>
						<td class="col-bar">
							<div class="bar-container">
								<div
									class="bar bar-dl"
									style="width: {(alias.downloadedGB / maxDownloaded) * 100}%"
								></div>
								<div
									class="bar bar-edit"
									style="width: {(alias.editedGB / maxDownloaded) * 100}%; background: {accent}"
								></div>
							</div>
						</td>
						<td class="col-num">{alias.downloadedCount}</td>
						<td class="col-num">{formatGB(alias.editedGB)}</td>
						<td class="col-num">{alias.editedCount}</td>
						<td class="col-num {alias.editPercent >= 50 ? 'high-edit' : alias.editPercent >= 20 ? 'mid-edit' : 'low-edit'}">
							{alias.editPercent}%
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else if loading}
		<p class="loading">Loading report...</p>
	{/if}
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
		background: #0f0f0f;
		color: #e0e0e0;
	}

	.dashboard {
		max-width: 1200px;
		margin: 0 auto;
		padding: 1.5rem;
	}

	header {
		margin-bottom: 1.5rem;
	}

	.provider-tabs {
		display: flex;
		gap: 0.25rem;
	}

	.tab {
		padding: 0.4rem 1rem;
		background: #1e1e1e;
		color: #888;
		border: 2px solid transparent;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
		transition: all 0.2s;
	}

	.tab:hover {
		background: #2a2a2a;
		color: #ccc;
	}

	.tab.active {
		background: #1a1a1a;
		font-weight: 600;
	}

	.controls {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}

	select,
	button:not(.tab) {
		padding: 0.4rem 0.8rem;
		background: #1e1e1e;
		color: #e0e0e0;
		border: 1px solid #333;
		border-radius: 4px;
		font-size: 0.9rem;
		cursor: pointer;
	}

	select:hover,
	button:not(.tab):hover {
		background: #2a2a2a;
	}

	button:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.snapshot-msg {
		color: #4ade80;
		font-size: 0.85rem;
	}

	.summary {
		display: flex;
		gap: 1rem;
		margin-bottom: 1.5rem;
		flex-wrap: wrap;
	}

	.stat {
		background: #1a1a1a;
		border: 1px solid #2a2a2a;
		border-radius: 8px;
		padding: 0.75rem 1.25rem;
		text-align: center;
		min-width: 100px;
	}

	.stat-value {
		display: block;
		font-size: 1.3rem;
		font-weight: 700;
		color: #fff;
	}

	.stat-label {
		display: block;
		font-size: 0.75rem;
		color: #888;
		margin-top: 0.2rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.snapshot-badge {
		border-color: #4ade80;
	}

	.snapshot-badge .stat-value {
		color: #4ade80;
		font-size: 0.9rem;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.85rem;
	}

	thead {
		position: sticky;
		top: 0;
		z-index: 1;
	}

	th {
		background: #1a1a1a;
		padding: 0.6rem 0.5rem;
		text-align: left;
		border-bottom: 2px solid #333;
		white-space: nowrap;
		user-select: none;
	}

	th.sortable {
		cursor: pointer;
	}

	th.sortable:hover {
		color: #fff;
	}

	td {
		padding: 0.4rem 0.5rem;
		border-bottom: 1px solid #1e1e1e;
	}

	tr:hover td {
		background: #1a1a1a;
	}

	.col-rank {
		width: 2rem;
		text-align: center;
		color: #555;
	}

	.col-alias {
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.col-num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	.col-bar {
		width: 200px;
	}

	.bar-container {
		position: relative;
		height: 16px;
		background: #1e1e1e;
		border-radius: 3px;
		overflow: hidden;
	}

	.bar {
		position: absolute;
		top: 0;
		left: 0;
		height: 100%;
		border-radius: 3px;
		transition: width 0.3s ease;
	}

	.bar-dl {
		background: #334155;
	}

	.high-edit {
		color: #4ade80;
	}

	.mid-edit {
		color: #facc15;
	}

	.low-edit {
		color: #888;
	}

	.loading {
		text-align: center;
		padding: 3rem;
		color: #666;
	}
</style>
