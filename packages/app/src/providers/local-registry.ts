import type { Provider } from '../constants.js';
import { localProvider } from './local.js';
import type { VideoProvider } from './types.js';

// One provider per site ID, made when first asked for (the server lists the sites).
const providers = new Map<Provider, VideoProvider>();
export function getProvider(id: Provider): VideoProvider {
	let provider = providers.get(id);
	if (!provider) providers.set(id, provider = localProvider(id));
	return provider;
}
