import { STORAGE_KEYS, VIDEO_TYPE } from '../constants.js';
import { startSync, stopSync } from '../services/sync.js';
import type { Video, VideoType } from '../types.js';

class PlayerStore {
	view = $state<'list' | 'video'>('list');
	currentVideo = $state<Video | null>(null);
	startTimeOverride = $state<number | null>(null);
	lastPlayedVideo = $state<Video | null>(null);
	segments = $state<number[]>([]);
	lastActionedVideoFilename = $state<string | null>(null);
	activePlayerIndex = $state(0);
	isUiVisible = $state(true);
	scrollAnchorRatio = $state(0);
	scrollTarget = $state<{ filename: string; type: VideoType; ratio: number } | null>(null);

	captureScrollAnchor(ratio: number) {
		this.scrollAnchorRatio = ratio;
	}

	updateScrollTarget(video: Video) {
		this.scrollTarget = { filename: video.filename, type: video.type, ratio: this.scrollAnchorRatio };
	}

	initialize(provider: string) {
		const saved = localStorage.getItem(`${STORAGE_KEYS.LAST_PLAYED_VIDEO}-${provider}`);
		if (saved) {
			this.lastPlayedVideo = JSON.parse(saved);
		}
	}

	playVideo(video: Video) {
		this.startTimeOverride = null;
		this._startPlaying(video);
		this.activePlayerIndex = 0;
	}

	navigateVideo(video: Video, direction: 1 | -1) {
		const newIndex = (this.activePlayerIndex + direction + 3) % 3;
		this.startTimeOverride = null;
		this._startPlaying(video);
		this.activePlayerIndex = newIndex;
	}

	private _onShowListCallback: (() => void) | null = null;
	private _onReloadCallback: (() => void) | null = null;
	private _onProviderChangeCallback: (() => void) | null = null;

	onShowList(cb: () => void) {
		this._onShowListCallback = cb;
	}

	onReload(cb: () => void) {
		this._onReloadCallback = cb;
	}

	onProviderChange(cb: () => void) {
		this._onProviderChangeCallback = cb;
	}

	triggerProviderChange() {
		this._onProviderChangeCallback?.();
	}

	private _lastProvider: string | null = null;

	showList(lastActionedFilename: string | null = null) {
		this.view = 'list';
		this.lastActionedVideoFilename = lastActionedFilename;
		this.scrollTarget = null;
		this.scrollAnchorRatio = 0;
		this._onShowListCallback?.();
		if (this._lastProvider) startSync(this._lastProvider);
	}

	addSegment(time: number) {
		if (!this.currentVideo || this.currentVideo.type !== VIDEO_TYPE.ORIGINAL) return;
		this.segments = [...this.segments, time].sort((a, b) => a - b);
	}

	removeLastSegment() {
		if (
			!this.currentVideo ||
			this.currentVideo.type !== VIDEO_TYPE.ORIGINAL ||
			this.segments.length === 0
		)
			return;
		this.segments = this.segments.slice(0, -1);
	}

	clearSegments() {
		this.segments = [];
	}

	reloadCurrentVideo() {
		this.startTimeOverride = 0;
		this._onReloadCallback?.();
	}

	setLastActioned(filename: string) {
		this.lastActionedVideoFilename = filename;
	}

	markCurrentAsEdited() {
		if (this.currentVideo) {
			const updated = { ...this.currentVideo, type: VIDEO_TYPE.EDITED };
			this.currentVideo = updated;
			this._persistVideo(updated);
		}
	}

	markCurrentAsOriginal() {
		if (this.currentVideo) {
			const updated = { ...this.currentVideo, type: VIDEO_TYPE.ORIGINAL };
			this.currentVideo = updated;
			this._persistVideo(updated);
		}
	}

	setCurrentVideoLive() {
		if (this.currentVideo && !this.currentVideo.isLive) {
			this.currentVideo = { ...this.currentVideo, isLive: true };
		}
	}

	setCurrentVideoNotLive() {
		if (this.currentVideo?.isLive) {
			this.currentVideo = { ...this.currentVideo, isLive: false };
		}
	}

	toggleUi() {
		this.isUiVisible = !this.isUiVisible;
	}

	private _persistVideo(video: Video) {
		localStorage.setItem(`${STORAGE_KEYS.LAST_PLAYED_VIDEO}-${video.provider}`, JSON.stringify(video));
		this.lastPlayedVideo = video;
	}

	private _startPlaying(video: Video) {
		stopSync();
		this._lastProvider = video.provider;
		this._persistVideo(video);
		this.currentVideo = video;
		this.segments = [];
		this.view = 'video';
		this.lastActionedVideoFilename = null;
	}
}

export const playerStore = new PlayerStore();
