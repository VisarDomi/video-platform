import type { Provider } from '../constants.js';
import { vault, vaultSites } from './vault.js';
import type { VideoProvider } from './types.js';

// Video Vault's list, and its two sites' videos.
export function getProvider(id: Provider): VideoProvider {
	if (id === vault.id) return vault;
	if (id in vaultSites) return vaultSites[id as keyof typeof vaultSites];
	throw new Error(`Provider is not included in this build: ${id}`);
}
