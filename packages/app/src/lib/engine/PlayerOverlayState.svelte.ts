import type { Video } from '../types.js';

export class PlayerOverlayState {
	video = $state<Video | null>(null);
	currentTime = $state(0);
	duration = $state(0);
	seekableEnd = $state(0);
	isMuted = $state(true);
	isActive = $state(false);
}
