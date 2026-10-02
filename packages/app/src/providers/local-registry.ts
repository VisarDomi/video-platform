import type { Provider } from '../constants.js';
import { localProvider } from './local.js';
import type { VideoProvider } from './types.js';

const providers = { tango: localProvider('tango'), fc2: localProvider('fc2'), sc: localProvider('sc') };
export function getProvider(id: Provider): VideoProvider {
	if (!(id in providers)) throw new Error(`Provider is not included in this build: ${id}`);
	return providers[id as keyof typeof providers];
}
