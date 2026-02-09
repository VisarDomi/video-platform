import { DEFAULT_PROVIDER, STORAGE_KEYS } from '../constants.js';
import type { Video, VideoType } from '../types.js';

class VideoListStore {
	videos = $state<Video[]>([]);
	isLoading = $state(true);
	selectedProvider = $state<string>(DEFAULT_PROVIDER);
	selectedAliases = $state<Set<string>>(new Set());

	initialize(provider: string) {
		this.selectedProvider = provider;
		this.isLoading = true;
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

	toggleAlias(alias: string) {
		const next = new Set(this.selectedAliases);
		if (next.has(alias)) {
			next.delete(alias);
		} else {
			next.add(alias);
		}
		this.selectedAliases = next;
	}

	removeAlias(alias: string) {
		const next = new Set(this.selectedAliases);
		next.delete(alias);
		this.selectedAliases = next;
	}

	clearAliases() {
		this.selectedAliases = new Set();
	}

	updateVideoType(filename: string, oldType: VideoType, newType: VideoType) {
		this.videos = this.videos.map((v) =>
			v.filename === filename && v.type === oldType ? { ...v, type: newType } : v
		);
	}
}

export const videoListStore = new VideoListStore();
