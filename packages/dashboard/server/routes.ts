import type { Express } from 'express';
import type { ProviderId, ProviderConfig } from './types.js';
import { parseProviderId, parseMonth } from './validation.js';
import {
	getAvailableMonths,
	generateReport,
	loadSnapshot,
	saveSnapshot
} from './provider.js';

export function registerRoutes(
	app: Express,
	registry: ReadonlyMap<ProviderId, Readonly<ProviderConfig>>
): void {
	app.get('/api/:provider/months', (req, res) => {
		const parsed = parseProviderId(req.params.provider);
		if (!parsed.ok) {
			res.status(400).json({ error: parsed.error });
			return;
		}
		const config = registry.get(parsed.value)!;
		res.json(getAvailableMonths(config));
	});

	app.get('/api/:provider/report/:month', (req, res) => {
		const prov = parseProviderId(req.params.provider);
		if (!prov.ok) {
			res.status(400).json({ error: prov.error });
			return;
		}
		const mo = parseMonth(req.params.month);
		if (!mo.ok) {
			res.status(400).json({ error: mo.error });
			return;
		}
		const config = registry.get(prov.value)!;
		const snapshot = loadSnapshot(config, mo.value);
		if (snapshot.ok) {
			res.json(snapshot.value);
			return;
		}
		res.json(generateReport(config, mo.value));
	});

	app.get('/api/:provider/report/:month/live', (req, res) => {
		const prov = parseProviderId(req.params.provider);
		if (!prov.ok) {
			res.status(400).json({ error: prov.error });
			return;
		}
		const mo = parseMonth(req.params.month);
		if (!mo.ok) {
			res.status(400).json({ error: mo.error });
			return;
		}
		const config = registry.get(prov.value)!;
		res.json(generateReport(config, mo.value));
	});

	app.post('/api/:provider/snapshot/:month', (req, res) => {
		const prov = parseProviderId(req.params.provider);
		if (!prov.ok) {
			res.status(400).json({ error: prov.error });
			return;
		}
		const mo = parseMonth(req.params.month);
		if (!mo.ok) {
			res.status(400).json({ error: mo.error });
			return;
		}
		const config = registry.get(prov.value)!;
		const result = saveSnapshot(config, mo.value);
		if (result.ok) {
			res.json({ saved: true, path: result.value });
		} else {
			res.status(500).json({ error: result.error });
		}
	});
}
