import { DEFAULT_PROVIDER, STORAGE_KEYS } from '../constants.js';
import type { Video, VideoType } from '../types.js';
import type { TlStreamer } from '../services/tl-api.js';

class VideoListStore {
	videos = $state<Video[]>([]);
	isLoading = $state(true);
	selectedProvider = $state<string>(DEFAULT_PROVIDER);
	selectedAliases = $state<Set<string>>(new Set());

	// Bumped on every initialize() — async ops capture this and bail if stale
	epoch = 0;

	// SC/FC2 follow state
	followedIdentifiers = $state<Set<string>>(new Set());

	// Tango list state (tango.txt download whitelist)
	listIdentifiers = $state<Set<string>>(new Set());

	// TL-specific state
	streamerMap = $state<Map<string, TlStreamer>>(new Map());
	processedStreamIds = new Set<string>();
	liveFilenameMap = $state<Map<string, string>>(new Map());

	initialize(provider: string) {
		this.epoch++;
		this.selectedProvider = provider;
		this.isLoading = true;
		this.videos = [];
		this.followedIdentifiers = new Set();
		this.listIdentifiers = new Set();
		this.streamerMap = new Map();
		this.processedStreamIds = new Set();
		this.liveFilenameMap = new Map();
	}

	initializeSoft(provider: string) {
		this.epoch++;
		this.selectedProvider = provider;
		// Do NOT wipe data — snapshot restore fills it in
	}

	removeStreamers(aliases: string[]) {
		if (aliases.length === 0) return;
		const removeSet = new Set(aliases);
		this.videos = this.videos.filter((v) => !removeSet.has(v.filename));
		const nextMap = new Map(this.streamerMap);
		for (const alias of aliases) {
			nextMap.delete(alias);
		}
		this.streamerMap = nextMap;
	}

	// Remove from video list only — keeps streamerMap entry so the alias
	// isn't re-added as "new" on next refresh cycle
	hideStreamers(aliases: string[]) {
		if (aliases.length === 0) return;
		const removeSet = new Set(aliases);
		this.videos = this.videos.filter((v) => !removeSet.has(v.filename));
	}

	updateStreamerLiveUrl(alias: string, liveUrl: string) {
		const streamer = this.streamerMap.get(alias);
		if (!streamer) return;
		const nextMap = new Map(this.streamerMap);
		nextMap.set(alias, { ...streamer, liveUrl });
		this.streamerMap = nextMap;
	}

	setProvider(newProvider: string) {
		localStorage.setItem(STORAGE_KEYS.SELECTED_PROVIDER, newProvider);
		this.epoch++;
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
	setFollowedIdentifiers(identifiers: string[]) {
		this.followedIdentifiers = new Set(identifiers);
	}

	addFollowedIdentifier(id: string) {
		this.followedIdentifiers = new Set(this.followedIdentifiers).add(id);
	}

	removeFollowedIdentifier(id: string) {
		const next = new Set(this.followedIdentifiers);
		next.delete(id);
		this.followedIdentifiers = next;
	}

	setListIdentifiers(identifiers: string[]) {
		this.listIdentifiers = new Set(identifiers);
	}

	addListIdentifier(id: string) {
		this.listIdentifiers = new Set(this.listIdentifiers).add(id);
	}

	removeListIdentifier(id: string) {
		const next = new Set(this.listIdentifiers);
		next.delete(id);
		this.listIdentifiers = next;
	}

	// TL-specific methods
	setStreamerMap(map: Map<string, TlStreamer>) {
		if (this.selectedProvider !== 'tl') return;
		this.streamerMap = map;
	}

	getStreamer(alias: string): TlStreamer | undefined {
		return this.streamerMap.get(alias);
	}

	setLiveFilenames(map: Record<string, string>) {
		if (this.selectedProvider !== 'tl') return;
		this.liveFilenameMap = new Map(Object.entries(map));
	}

	getLiveFilename(alias: string): string | undefined {
		return this.liveFilenameMap.get(alias);
	}

	markStreamIdProcessed(streamId: string): boolean {
		if (this.selectedProvider !== 'tl') return false;
		if (this.processedStreamIds.has(streamId)) return false;
		this.processedStreamIds.add(streamId);
		return true;
	}

	insertVideosAfter(afterFilename: string, newVideos: Video[], newStreamers: TlStreamer[]) {
		if (this.selectedProvider !== 'tl') return;
		if (newVideos.length === 0) return;
		const existing = new Set(this.videos.map((v) => v.filename));
		const toAdd = newVideos.filter((v) => !existing.has(v.filename));
		if (toAdd.length === 0) return;
		const idx = this.videos.findIndex((v) => v.filename === afterFilename);
		const insertAt = idx === -1 ? this.videos.length : idx + 1;
		const updated = [...this.videos];
		updated.splice(insertAt, 0, ...toAdd);
		this.videos = updated;
		const nextMap = new Map(this.streamerMap);
		for (const s of newStreamers) {
			nextMap.set(s.alias, s);
		}
		this.streamerMap = nextMap;
	}

	appendVideos(newVideos: Video[]) {
		if (this.selectedProvider !== 'tl') return;
		if (newVideos.length === 0) return;
		const existing = new Set(this.videos.map((v) => v.filename));
		const toAdd = newVideos.filter((v) => !existing.has(v.filename));
		if (toAdd.length === 0) return;
		// Don't sort - keep following first, then recommended
		this.videos = [...this.videos, ...toAdd];
	}
}

export const videoListStore = new VideoListStore();
