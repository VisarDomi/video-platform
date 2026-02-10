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

	addVideos(newVideos: Video[]) {
		if (newVideos.length === 0) return;
		const existing = new Set(this.videos.map((v) => v.filename + v.type));
		const toAdd = newVideos.filter((v) => !existing.has(v.filename + v.type));
		if (toAdd.length === 0) return;
		const merged = [...this.videos, ...toAdd];
		merged.sort((a, b) => a.filename.localeCompare(b.filename));
		this.videos = merged;
	}

	removeVideo(filename: string) {
		this.videos = this.videos.filter((v) => v.filename !== filename);
	}

	getLatestFilename(): string | null {
		if (this.videos.length === 0) return null;
		return this.videos[this.videos.length - 1].filename;
	}

	updateVideoLive(filename: string, isLive: boolean) {
		const target = this.videos.find((v) => v.filename === filename);
		if (!target || target.isLive === isLive) return;
		this.videos = this.videos.map((v) => (v.filename === filename ? { ...v, isLive } : v));
	}

	updateVideoType(filename: string, oldType: VideoType, newType: VideoType) {
		this.videos = this.videos.map((v) =>
			v.filename === filename && v.type === oldType ? { ...v, type: newType } : v
		);
	}
}

export const videoListStore = new VideoListStore();
