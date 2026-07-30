import Hls from 'hls.js';
import { API, USE_NATIVE_HLS } from '../constants.js';
import { fetchPlaylist } from '../services/hls.js';
import type { Video } from '../types.js';
import { PlaybackTimeline, type TimelineSnapshot } from './PlaybackTimeline.js';

export interface PlayerUnitCallbacks {
	onTime(unit: PlayerUnit, snapshot: TimelineSnapshot): void;
	onLiveChanged(unit: PlayerUnit, isLive: boolean): void;
	onMutedChanged(unit: PlayerUnit, muted: boolean): void;
}

export class PlayerUnit {
	readonly wrapper = document.createElement('section');
	readonly video = document.createElement('video');
	readonly timeline = new PlaybackTimeline();
	currentVideo: Video | null = null;

	private hls: Hls | null = null;
	private mediaEvents: AbortController | null = null;
	private loadToken = 0;
	private lastOverlayUpdate = 0;
	private playlistFetchPending = false;
	private playlistRefreshTimer: number | null = null;

	constructor(private readonly callbacks: PlayerUnitCallbacks) {
		this.wrapper.className = 'player-scope background-unit';
		this.video.playsInline = true;
		this.video.preload = 'auto';
		this.video.muted = true;
		this.wrapper.append(this.video);
	}

	async load(video: Video, startTime: number, shouldPlay: boolean): Promise<void> {
		if (
			this.currentVideo?.filename === video.filename &&
			this.currentVideo.type === video.type &&
			this.video.src
		) {
			if (shouldPlay) await this.play();
			else this.video.pause();
			return;
		}

		const token = ++this.loadToken;
		this.clearMedia();
		this.currentVideo = video;
		this.timeline.clear();

		const events = new AbortController();
		this.mediaEvents = events;
		const signal = events.signal;
		this.video.addEventListener('timeupdate', this.handleTimeUpdate, { signal });
		this.video.addEventListener('durationchange', this.handleMediaChange, { signal });
		this.video.addEventListener('volumechange', this.handleVolumeChange, { signal });
		this.video.addEventListener('ended', this.handleEnded, { signal });
		this.video.addEventListener('error', this.handleError, { signal });
		this.video.hidden = false;

		if (!USE_NATIVE_HLS && Hls.isSupported()) {
			this.loadWithHlsJs(video, startTime, shouldPlay, token);
		} else {
			this.loadNative(video, startTime, shouldPlay, token);
		}

		void this.refreshPlaylistTruth(video, token);
	}

	clear(): void {
		this.loadToken++;
		this.clearMedia();
		this.currentVideo = null;
		this.timeline.clear();
		this.video.hidden = true;
	}

	setActive(active: boolean): void {
		this.wrapper.classList.toggle('active-unit', active);
		this.wrapper.classList.toggle('background-unit', !active);
		if (!active) this.video.muted = true;
	}

	updateVideo(video: Video): void {
		this.currentVideo = video;
	}

	seek(time: number, resume: boolean): void {
		const snapshot = this.observe();
		if (snapshot.seekMax <= 0) return;
		const terminal =
			snapshot.seekableEnd !== null && snapshot.seekableEnd > 0
				? Math.min(snapshot.seekableEnd, snapshot.seekMax)
				: snapshot.seekMax;
		let target = Math.max(0, Math.min(time, snapshot.seekMax));
		const shouldResume = resume && (snapshot.isLive || target < terminal - 0.1);
		if (!shouldResume && target >= terminal - 0.1) target = Math.max(0, terminal - 0.1);
		if (resume) this.video.pause();
		this.video.currentTime = target;
		this.emitTime();
		if (shouldResume && resume) {
			this.video.addEventListener('seeked', () => void this.play(), { once: true });
		}
	}

	toggleMute(): void {
		this.video.muted = !this.video.muted;
	}

	getSnapshot(): TimelineSnapshot {
		return this.observe();
	}

	async play(): Promise<void> {
		try {
			await this.video.play();
		} catch (error) {
			console.warn('Video play failed', error);
		}
	}

	resume(): void {
		if (!this.currentVideo) return;
		if (this.hls) {
			this.hls.startLoad();
			void this.play();
			return;
		}
		const time = this.video.currentTime;
		const isLive = this.timeline.snapshot().isLive;
		this.video.load();
		this.video.addEventListener(
			'loadedmetadata',
			() => {
				if (!isLive && time > 0) this.video.currentTime = time;
				void this.play();
			},
			{ once: true }
		);
	}

	private loadNative(video: Video, startTime: number, shouldPlay: boolean, token: number): void {
		this.video.addEventListener(
			'loadedmetadata',
			() => {
				if (token !== this.loadToken) return;
				this.timeline.observe(this.video);
				if (startTime > 0 && !this.timeline.snapshot().isLive) {
					this.video.currentTime = this.timeline.clampSeekTarget(startTime);
				}
				this.emitTime();
				if (shouldPlay) void this.play();
				else this.video.pause();
			},
			{ once: true, signal: this.mediaEvents?.signal }
		);
		this.video.src = API.HLS_PLAYLIST(video.provider, video.filename);
		this.video.load();
		if (shouldPlay) void this.play();
	}

	private loadWithHlsJs(video: Video, startTime: number, shouldPlay: boolean, token: number): void {
		const hls = new Hls({ startPosition: startTime > 0 ? startTime : -1 });
		this.hls = hls;
		hls.loadSource(API.HLS_PLAYLIST(video.provider, video.filename));
		hls.attachMedia(this.video);
		hls.on(Hls.Events.MANIFEST_PARSED, () => {
			if (token !== this.loadToken) return;
			if (shouldPlay) void this.play();
			else this.video.pause();
		});
		hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
			if (token !== this.loadToken) return;
			const isLive = data.details.live;
			const duration = data.details.totalduration;
			this.timeline.setPlaylistTruth({ totalDuration: duration, isLive });
			this.emitTime();
			if (video.isLive !== isLive) this.callbacks.onLiveChanged(this, isLive);
		});
		hls.on(Hls.Events.ERROR, (_event, data) => {
			if (!data.fatal) return;
			if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
			else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
		});
	}

	private readonly handleTimeUpdate = (): void => {
		const snapshot = this.observe();
		const now = performance.now();
		if (now - this.lastOverlayUpdate >= 250) {
			this.lastOverlayUpdate = now;
			this.callbacks.onTime(this, snapshot);
		}
	};

	private readonly handleMediaChange = (): void => {
		this.emitTime();
		this.reconcileNativeFinalization();
	};

	private readonly handleVolumeChange = (): void => {
		this.callbacks.onMutedChanged(this, this.video.muted);
	};

	private readonly handleEnded = (): void => {
		this.emitTime();
		this.reconcileNativeFinalization();
		if (this.timeline.hasRemainingMedia()) {
			console.warn('Native ended before the authoritative playlist timeline was exhausted');
		}
	};

	private readonly handleError = (): void => {
		console.error('Video element error', this.video.error);
	};

	private observe(): TimelineSnapshot {
		this.timeline.observe(this.video);
		return this.timeline.snapshot();
	}

	private emitTime(): void {
		this.callbacks.onTime(this, this.observe());
	}

	private reconcileNativeFinalization(): void {
		if (!this.currentVideo || !Number.isFinite(this.video.duration)) return;
		if (!this.timeline.snapshot().isLive) return;
		void this.refreshPlaylistTruth(this.currentVideo, this.loadToken);
	}

	private async refreshPlaylistTruth(video: Video, token: number): Promise<void> {
		if (this.playlistFetchPending) return;
		this.playlistFetchPending = true;
		if (this.playlistRefreshTimer !== null) clearTimeout(this.playlistRefreshTimer);
		this.playlistRefreshTimer = null;
		try {
			const playlist = await fetchPlaylist(video);
			if (token !== this.loadToken) return;
			const totalDuration = playlist.segments.reduce(
				(total, segment) => Math.max(total, segment.end),
				0
			);
			this.timeline.setPlaylistTruth({
				totalDuration,
				isLive: playlist.isLive,
				segments: playlist.segments
			});
			this.emitTime();
			if (video.isLive !== playlist.isLive) {
				this.callbacks.onLiveChanged(this, playlist.isLive);
			}
			if (playlist.isLive && Number.isFinite(this.video.duration)) {
				this.schedulePlaylistRefresh(video, token);
			}
		} catch (error) {
			console.error('Playlist authority fetch failed', error);
			if (
				token === this.loadToken &&
				Number.isFinite(this.video.duration) &&
				this.timeline.snapshot().isLive
			) {
				this.schedulePlaylistRefresh(video, token);
			}
		} finally {
			if (token === this.loadToken) this.playlistFetchPending = false;
		}
	}

	private schedulePlaylistRefresh(video: Video, token: number): void {
		if (this.playlistRefreshTimer !== null) clearTimeout(this.playlistRefreshTimer);
		this.playlistRefreshTimer = window.setTimeout(
			() => void this.refreshPlaylistTruth(video, token),
			1000
		);
	}

	private clearMedia(): void {
		if (this.playlistRefreshTimer !== null) clearTimeout(this.playlistRefreshTimer);
		this.playlistRefreshTimer = null;
		this.playlistFetchPending = false;
		this.mediaEvents?.abort();
		this.mediaEvents = null;
		this.hls?.destroy();
		this.hls = null;
		this.video.pause();
		this.video.removeAttribute('src');
		this.video.load();
	}
}
