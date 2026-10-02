import type { Provider } from '../constants.js';
import { porntrex } from './porntrex.js';
import type { VideoProvider } from './types.js';

export function getProvider(id: Provider): VideoProvider {
	if (id !== porntrex.id) throw new Error(`Provider is not included in this build: ${id}`);
	return porntrex;
}
