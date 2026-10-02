import type { Provider } from '../constants.js';
import { tangoLive } from './tango-live.js';
import type { VideoProvider } from './types.js';

export function getProvider(id: Provider): VideoProvider {
	if (id !== tangoLive.id) throw new Error(`Provider is not included in this build: ${id}`);
	return tangoLive;
}
