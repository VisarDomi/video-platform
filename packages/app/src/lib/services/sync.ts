import { videoListStore } from '../stores/videoList.svelte.js';
import { fetchNewVideos } from './api.js';

let intervalId: ReturnType<typeof setInterval> | null = null;
let polling = false;

export function startSync(provider: string) {
	stopSync();
	intervalId = setInterval(async () => {
		if (polling) return;
		const latest = videoListStore.getLatestFilename();
		if (!latest) return;

		polling = true;
		try {
			const newVideos = await fetchNewVideos(provider, latest);
			if (newVideos.length > 0) {
				videoListStore.addVideos(newVideos);
			}
		} catch {
		} finally {
			polling = false;
		}
	}, 1000);
}

export function stopSync() {
	if (intervalId !== null) {
		clearInterval(intervalId);
		intervalId = null;
	}
	polling = false;
}
