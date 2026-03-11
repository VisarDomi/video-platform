import fs from 'fs';
import path from 'path';
import type { ProviderConfig, AliasReport, MonthReport } from './types.js';
import { Ok, Err, type Result } from './result.js';

function getDirSizeSync(dirPath: string): number {
	let total = 0;
	try {
		const entries = fs.readdirSync(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dirPath, entry.name);
			if (entry.isDirectory()) {
				total += getDirSizeSync(fullPath);
			} else {
				try {
					total += fs.statSync(fullPath).size;
				} catch {}
			}
		}
	} catch {}
	return total;
}

export function scanDirectory(
	baseDir: string,
	monthPrefix: string
): Map<string, { size: number; count: number }> {
	const result = new Map<string, { size: number; count: number }>();

	try {
		const entries = fs.readdirSync(baseDir);
		for (const entry of entries) {
			if (!entry.startsWith(monthPrefix)) continue;

			const parts = entry.split(' ');
			if (parts.length < 3) continue;
			const alias = parts.slice(2).join(' ');

			const fullPath = path.join(baseDir, entry);
			const size = getDirSizeSync(fullPath);

			const existing = result.get(alias) || { size: 0, count: 0 };
			existing.size += size;
			existing.count += 1;
			result.set(alias, existing);
		}
	} catch (err) {
		console.error(`Error scanning ${baseDir}:`, err);
	}

	return result;
}

export function generateReport(
	config: Readonly<ProviderConfig>,
	month: string
): MonthReport {
	const downloaded = scanDirectory(config.downloaderDir, month);
	const edited = scanDirectory(config.editedDir, month);

	const allAliases = new Set([...downloaded.keys(), ...edited.keys()]);
	const aliases: AliasReport[] = [];

	for (const alias of allAliases) {
		const dl = downloaded.get(alias) || { size: 0, count: 0 };
		const ed = edited.get(alias) || { size: 0, count: 0 };
		const downloadedGB = dl.size / 1073741824;
		const editedGB = ed.size / 1073741824;

		aliases.push({
			alias,
			downloadedGB: Math.round(downloadedGB * 100) / 100,
			downloadedCount: dl.count,
			editedGB: Math.round(editedGB * 100) / 100,
			editedCount: ed.count,
			editPercent:
				downloadedGB > 0
					? Math.round((editedGB / downloadedGB) * 1000) / 10
					: 0
		});
	}

	aliases.sort((a, b) => b.downloadedGB - a.downloadedGB);

	const totalDownloadedGB = aliases.reduce((s, a) => s + a.downloadedGB, 0);
	const totalEditedGB = aliases.reduce((s, a) => s + a.editedGB, 0);
	const totalDownloadedCount = aliases.reduce(
		(s, a) => s + a.downloadedCount,
		0
	);
	const totalEditedCount = aliases.reduce((s, a) => s + a.editedCount, 0);

	return {
		provider: config.id,
		month,
		generatedAt: new Date().toISOString(),
		totalDownloadedGB: Math.round(totalDownloadedGB * 100) / 100,
		totalEditedGB: Math.round(totalEditedGB * 100) / 100,
		totalDownloadedCount,
		totalEditedCount,
		overallEditPercent:
			totalDownloadedGB > 0
				? Math.round((totalEditedGB / totalDownloadedGB) * 1000) / 10
				: 0,
		aliases
	};
}

export function getAvailableMonths(
	config: Readonly<ProviderConfig>
): string[] {
	const months = new Set<string>();
	try {
		for (const entry of fs.readdirSync(config.downloaderDir)) {
			const match = entry.match(/^(\d{4}-\d{2})/);
			if (match) months.add(match[1]);
		}
	} catch {}
	return [...months].sort().reverse();
}

export function loadSnapshot(
	config: Readonly<ProviderConfig>,
	month: string
): Result<MonthReport> {
	const snapshotPath = path.join(config.snapshotsDir, `${month}.json`);
	if (!fs.existsSync(snapshotPath)) {
		return Err('No snapshot found');
	}
	const data = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
	return Ok({ ...data, provider: config.id, fromSnapshot: true });
}

export function saveSnapshot(
	config: Readonly<ProviderConfig>,
	month: string
): Result<string> {
	const report = generateReport(config, month);
	fs.mkdirSync(config.snapshotsDir, { recursive: true });
	const snapshotPath = path.join(config.snapshotsDir, `${month}.json`);
	fs.writeFileSync(snapshotPath, JSON.stringify(report, null, 2));
	return Ok(snapshotPath);
}
