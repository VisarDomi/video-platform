export { getProvider } from '@providers';
export { ApiError, AuthenticationRequiredError } from './types.js';
export type { VideoProvider, OnlineVideoProvider, MediaSource } from './types.js';

import { getProvider } from '@providers';
import type { Provider } from '../constants.js';
import type { Video } from '../types.js';

export function localActions(id: Provider) {
	const provider = getProvider(id);
	if (provider.kind !== 'local') throw new Error('This provider only supports playback.');
	return provider;
}

export function videoUrl(video: Video): string { return getProvider(video.provider).videoUrl(video); }
