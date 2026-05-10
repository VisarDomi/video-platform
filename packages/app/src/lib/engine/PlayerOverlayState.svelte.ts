import { videoListStore } from '../stores/videoList.svelte.js';

export class PlayerOverlayState {
	loadedFilename = $state<string | null>(null);
	video = $derived(
		this.loadedFilename
			? videoListStore.videos.find((v) => v.filename === this.loadedFilename) ?? null
			: null
	);
	currentTime = $state(0);
	duration = $state(0);
	seekableEnd = $state(0);
	currentSegmentName = $state<string | null>(null);
	isLive = $state(false);
	isMuted = $state(true);
	isActive = $state(false);
}
