import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = express();
app.use(cors());
app.use(express.json());

const TANGO_BASE = path.join(os.homedir(), 'Videos/downloads/tango');
const DOWNLOADER_DIR = path.join(TANGO_BASE, 'downloader');
const EDITED_DIR = path.join(TANGO_BASE, 'editor/edited');
const SNAPSHOTS_DIR = path.join(import.meta.dirname, '..', 'snapshots');

interface AliasReport {
	alias: string;
	downloadedGB: number;
	downloadedCount: number;
	editedGB: number;
	editedCount: number;
	editPercent: number;
}

interface MonthReport {
	month: string;
	generatedAt: string;
	totalDownloadedGB: number;
	totalEditedGB: number;
	totalDownloadedCount: number;
	totalEditedCount: number;
	overallEditPercent: number;
	aliases: AliasReport[];
}

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

function scanDirectory(baseDir: string, monthPrefix: string): Map<string, { size: number; count: number }> {
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

function generateReport(month: string): MonthReport {
	const downloaded = scanDirectory(DOWNLOADER_DIR, month);
	const edited = scanDirectory(EDITED_DIR, month);

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
			editPercent: downloadedGB > 0 ? Math.round((editedGB / downloadedGB) * 1000) / 10 : 0
		});
	}

	aliases.sort((a, b) => b.downloadedGB - a.downloadedGB);

	const totalDownloadedGB = aliases.reduce((s, a) => s + a.downloadedGB, 0);
	const totalEditedGB = aliases.reduce((s, a) => s + a.editedGB, 0);
	const totalDownloadedCount = aliases.reduce((s, a) => s + a.downloadedCount, 0);
	const totalEditedCount = aliases.reduce((s, a) => s + a.editedCount, 0);

	return {
		month,
		generatedAt: new Date().toISOString(),
		totalDownloadedGB: Math.round(totalDownloadedGB * 100) / 100,
		totalEditedGB: Math.round(totalEditedGB * 100) / 100,
		totalDownloadedCount,
		totalEditedCount,
		overallEditPercent: totalDownloadedGB > 0 ? Math.round((totalEditedGB / totalDownloadedGB) * 1000) / 10 : 0,
		aliases
	};
}

function getAvailableMonths(): string[] {
	const months = new Set<string>();
	try {
		for (const entry of fs.readdirSync(DOWNLOADER_DIR)) {
			const match = entry.match(/^(\d{4}-\d{2})/);
			if (match) months.add(match[1]);
		}
	} catch {}
	return [...months].sort().reverse();
}

// --- Routes ---

app.get('/api/months', (_req, res) => {
	res.json(getAvailableMonths());
});

app.get('/api/report/:month', (req, res) => {
	const month = req.params.month;
	if (!/^\d{4}-\d{2}$/.test(month)) {
		res.status(400).json({ error: 'Invalid month format. Use YYYY-MM.' });
		return;
	}

	// Check for saved snapshot first
	const snapshotPath = path.join(SNAPSHOTS_DIR, `${month}.json`);
	if (fs.existsSync(snapshotPath)) {
		const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
		res.json({ ...snapshot, fromSnapshot: true });
		return;
	}

	const report = generateReport(month);
	res.json(report);
});

app.post('/api/snapshot/:month', (req, res) => {
	const month = req.params.month;
	if (!/^\d{4}-\d{2}$/.test(month)) {
		res.status(400).json({ error: 'Invalid month format. Use YYYY-MM.' });
		return;
	}

	const report = generateReport(month);
	fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
	const snapshotPath = path.join(SNAPSHOTS_DIR, `${month}.json`);
	fs.writeFileSync(snapshotPath, JSON.stringify(report, null, 2));
	res.json({ saved: true, path: snapshotPath });
});

app.get('/api/report/:month/live', (req, res) => {
	const month = req.params.month;
	if (!/^\d{4}-\d{2}$/.test(month)) {
		res.status(400).json({ error: 'Invalid month format. Use YYYY-MM.' });
		return;
	}
	res.json(generateReport(month));
});

const FRONTEND_DIST = path.join(import.meta.dirname, '..', 'build');

// Serve static frontend
app.use(express.static(FRONTEND_DIST));
app.get(/.*/, (_req, res) => {
	res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
});

const PORT = 7976;
const HOST = '0.0.0.0';

const mkcertPath = path.join(os.homedir(), '.local/share/mkcert/pwa');
const keyPath = path.join(mkcertPath, 'key.pem');
const certPath = path.join(mkcertPath, 'cert.pem');

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
	const sslOptions = {
		key: fs.readFileSync(keyPath),
		cert: fs.readFileSync(certPath)
	};
	https.createServer(sslOptions, app).listen(PORT, HOST, () => {
		const interfaces = os.networkInterfaces();
		for (const [, addrs] of Object.entries(interfaces)) {
			for (const addr of addrs || []) {
				if (addr.family === 'IPv4' && !addr.internal) {
					console.log(`Dashboard running at https://${addr.address}:${PORT}`);
				}
			}
		}
	});
} else {
	console.warn('SSL certs not found, falling back to HTTP');
	app.listen(PORT, HOST, () => {
		console.log(`Dashboard running at http://localhost:${PORT}`);
	});
}
