import { DEFAULT_PROVIDER, STORAGE_KEYS } from '../constants.js';
import type { Video, VideoType } from '../types.js';

class VideoListStore {
	videos = $state<Video[]>([]);
	isLoading = $state(true);
	filter = $state('');
	selectedProvider = $state<string>(DEFAULT_PROVIDER);

	initialize(provider: string) {
		this.selectedProvider = provider;
		this.isLoading = true;
	}

	setFilter(newFilter: string) {
		this.filter = newFilter;
	}

	setProvider(newProvider: string) {
		localStorage.setItem(STORAGE_KEYS.SELECTED_PROVIDER, newProvider);
		this.selectedProvider = newProvider;
	}

	setVideos(videos: Video[]) {
		this.videos = videos;
		this.isLoading = false;
	}

	setLoading(loading: boolean) {
		this.isLoading = loading;
	}

	updateVideoType(filename: string, oldType: VideoType, newType: VideoType) {
		this.videos = this.videos.map((v) =>
			v.filename === filename && v.type === oldType ? { ...v, type: newType } : v
		);
	}
}

export const videoListStore = new VideoListStore();
