import path from 'path';
import os from 'os';
import { PROVIDER_IDS, type ProviderId, type ProviderConfig } from './types.js';

export function createRegistry(
	snapshotsBase: string
): ReadonlyMap<ProviderId, Readonly<ProviderConfig>> {
	const base = path.join(os.homedir(), 'Videos/downloads');
	const entries: [ProviderId, Readonly<ProviderConfig>][] = PROVIDER_IDS.map(
		(id) => {
			const config: ProviderConfig = Object.freeze({
				id,
				downloaderDir: path.join(base, id, 'downloader'),
				editedDir: path.join(base, id, 'editor/edited'),
				snapshotsDir: path.join(snapshotsBase, id)
			});
			return [id, config];
		}
	);
	return new Map(entries);
}
