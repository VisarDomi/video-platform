import type { Provider } from '../constants.js';
import { xvideos } from './xvideos.js';
import type { VideoProvider } from './types.js';

export function getProvider(id: Provider): VideoProvider {
	if (id !== xvideos.id) throw new Error(`Provider is not included in this build: ${id}`);
	return xvideos;
}
