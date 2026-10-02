import type { Provider } from '../constants.js';
import { localProvider } from './local.js';
import type { VideoProvider } from './types.js';

const providers = { tslive: localProvider('tslive'), ladder: localProvider('ladder'), fmp4: localProvider('fmp4') };
export function getProvider(id: Provider): VideoProvider {
	if (!(id in providers)) throw new Error(`Provider is not included in this build: ${id}`);
	return providers[id as keyof typeof providers];
}
