import { STORAGE_KEYS, VIDEO_TYPE } from '../constants.js';
import type { Video } from '../types.js';

class PlayerStore {
	view = $state<'list' | 'video'>('list');
	currentVideo = $state<Video | null>(null);
	currentVideoStartTime = $state(0);
	lastPlayedVideo = $state<Video | null>(null);
	segments = $state<number[]>([]);
	lastActionedVideoFilename = $state<string | null>(null);
	activePlayerIndex = $state(0);
	isUiVisible = $state(false);
	swipeProgress = $state(0);
	isSwiping = $state(false);
	swipeAnimating = $state(false);

	initialize(provider: string) {
		const saved = localStorage.getItem(`${STORAGE_KEYS.LAST_PLAYED_VIDEO}-${provider}`);
		if (saved) {
			this.lastPlayedVideo = JSON.parse(saved);
		}
	}

	playVideo(video: Video, startTime: number, provider: string) {
		this._startPlaying(video, startTime, provider);
		this.activePlayerIndex = 0;
	}

	navigateVideo(video: Video, startTime: number, direction: 1 | -1, provider: string) {
		const newIndex = (this.activePlayerIndex + direction + 3) % 3;
		this._startPlaying(video, startTime, provider);
		this.activePlayerIndex = newIndex;
	}

	setEditedVideo(video: Video, startTime: number, provider: string) {
		const newIndex = (this.activePlayerIndex + 1 + 3) % 3;
		this._startPlaying(video, startTime, provider);
		this.activePlayerIndex = newIndex;
	}

	showList(lastActionedFilename: string | null = null) {
		this.view = 'list';
		this.lastActionedVideoFilename = lastActionedFilename;
	}

	reloadToken = $state(0);

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
		this.currentVideoStartTime = 0;
		this.reloadToken++;
	}

	setLastActioned(filename: string) {
		this.lastActionedVideoFilename = filename;
	}

	markCurrentAsEdited(provider: string) {
		if (this.currentVideo) {
			const updated = { ...this.currentVideo, type: VIDEO_TYPE.EDITED };
			this.currentVideo = updated;
			this._persistVideo(updated, provider);
		}
	}

	markCurrentAsOriginal(provider: string) {
		if (this.currentVideo) {
			const updated = { ...this.currentVideo, type: VIDEO_TYPE.ORIGINAL };
			this.currentVideo = updated;
			this._persistVideo(updated, provider);
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

	private _persistVideo(video: Video, provider: string) {
		localStorage.setItem(`${STORAGE_KEYS.LAST_PLAYED_VIDEO}-${provider}`, JSON.stringify(video));
		this.lastPlayedVideo = video;
	}

	private _startPlaying(video: Video, startTime: number, provider: string) {
		this._persistVideo(video, provider);
		this.currentVideo = video;
		this.currentVideoStartTime = startTime;
		this.segments = [];
		this.view = 'video';
		this.lastActionedVideoFilename = null;
		this.isUiVisible = false;
	}
}

export const playerStore = new PlayerStore();
