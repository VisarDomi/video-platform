import { STORAGE_KEYS, VIDEO_TYPE, type Provider } from '../constants.js';
import { ApiError, editVideo, fetchVideos, returnVideo, saveVideo } from '../services/api.js';
import {
	changeMembership,
	extractIdentifier,
	fetchMembership,
	type MembershipState
} from '../services/downloadList.js';
import { calculateSegmentsToKeep, fetchPlaylist } from '../services/hls.js';
import { GestureController } from '../player/GestureController.js';
import { OverlayView, type OverlayActions, type OverlayTimeline } from '../player/OverlayView.js';
import { PlayerUnit } from '../player/PlayerUnit.js';
import type { TimelineSnapshot } from '../player/PlaybackTimeline.js';
import type { Video, VideoType } from '../types.js';

const SETTLEMENT_DELAY_MS = 100;
const GEOMETRY_WAIT_MS = 8000;
const PROGRESS_SAVE_MS = 3000;

export class VideoViewerPage {
	private readonly stage = document.createElement('main');
	private readonly overlay: OverlayView;
	private units: PlayerUnit[] = [];
	private videos: Video[] = [];
	private currentIndex = -1;
	private gesture!: GestureController;
	private segments: number[] = [];
	private controlsVisible = true;
	private unsettled = false;
	private settlementTimer: number | null = null;
	private ignoreNextScrollEnd = false;
	private programmaticScroll = false;
	private lastProgressSave = 0;
	private membership: MembershipState = { state: 'loading' };
	private membershipToken = 0;

	constructor(
		private readonly provider: Provider,
		private readonly requestedFilename: string,
		private readonly requestedType: VideoType | null
	) {
		this.stage.className = 'video-stage viewer-loading';
		this.overlay = new OverlayView(this.actions());
	}

	async open(): Promise<void> {
		document.body.className = 'viewer-page';
		history.scrollRestoration = 'manual';

		this.units = [0, 1, 2].map(() => new PlayerUnit(this.unitCallbacks()));
		this.applyScopeRoles();
		document.body.replaceChildren(this.stage, this.overlay.element);

		const provisional = this.provisionalVideo();
		this.overlay.setUiVisible(this.controlsVisible);
		this.overlay.setVideo(provisional);
		this.activeUnit().setActive(true);

		// The URL-selected media gets the network first. Everything else is auxiliary.
		void this.activeUnit().load(provisional, savedTime(provisional), true);
		void this.requestWakeLock();

		const revealTask = this.revealWhenCurrentGeometryIsReady();
		const listTask = this.loadCanonicalListAndNeighbors();
		await Promise.all([revealTask, listTask]);

		this.ignoreNextScrollEnd = false;
		this.gesture = new GestureController(this.stage, this.gestureCallbacks());
		addEventListener('scroll', this.handleScroll, { passive: true });
		addEventListener('scrollend', this.handleScrollEnd);
		addEventListener('pagehide', this.handlePageHide);
		addEventListener('pageshow', this.handlePageShow);
		document.addEventListener('visibilitychange', this.handleVisibility);
		addEventListener('online', this.handleOnline);
	}

	private provisionalVideo(): Video {
		return {
			filename: this.requestedFilename,
			type: this.requestedType ?? VIDEO_TYPE.ORIGINAL,
			duration: 0,
			size: 0,
			isLive: false,
			provider: this.provider
		};
	}

	private async loadCanonicalListAndNeighbors(): Promise<void> {
		const videos = await fetchVideos(this.provider);
		const index = videos.findIndex(
			(video) =>
				video.filename === this.requestedFilename &&
				(this.requestedType === null || video.type === this.requestedType)
		);
		if (index < 0) throw new Error('Video not found.');

		this.videos = videos;
		this.currentIndex = index;
		this.activeUnit().updateVideo(this.current());
		this.loadEdgeUnits();
		this.activateCurrent();
	}

	private async revealWhenCurrentGeometryIsReady(): Promise<void> {
		const video = this.activeUnit().video;
		if (video.videoWidth === 0 || video.videoHeight === 0) {
			await new Promise<void>((resolve) => {
				let timeout = 0;
				const finish = () => {
					clearTimeout(timeout);
					video.removeEventListener('resize', ready);
					video.removeEventListener('loadedmetadata', ready);
					video.removeEventListener('error', finish);
					resolve();
				};
				const ready = () => {
					if (video.videoWidth > 0 && video.videoHeight > 0) finish();
				};
				video.addEventListener('resize', ready);
				video.addEventListener('loadedmetadata', ready);
				video.addEventListener('error', finish, { once: true });
				timeout = window.setTimeout(finish, GEOMETRY_WAIT_MS);
			});
		}
		this.centerVideo(this.activeUnit().video);
		this.stage.classList.remove('viewer-loading');
	}

	private current(): Video {
		const video = this.videos[this.currentIndex] ?? this.activeUnit().currentVideo;
		if (!video) throw new Error('No current video.');
		return video;
	}

	private actions(): OverlayActions {
		return {
			onSeek: (time) => this.activeUnit().seek(time, true),
			onSeekDirect: (time) => this.activeUnit().seek(time, false),
			onToggleMuteOrUndo: () => this.toggleMuteOrUndo(),
			onToggleMembership: () => void this.toggleMembership(),
			onReturnOriginal: () => void this.returnOriginal(),
			onSaveOrCut: (duration) => void this.saveOrCut(duration),
			onAddMarker: () => this.addMarker()
		};
	}

	private unitCallbacks() {
		return {
			onTime: (unit: PlayerUnit, snapshot: TimelineSnapshot) => {
				if (unit !== this.activeUnit()) return;
				this.overlay.setTimeline(overlayTimeline(snapshot));
				const now = Date.now();
				if (now - this.lastProgressSave >= PROGRESS_SAVE_MS) {
					this.lastProgressSave = now;
					this.saveProgress(snapshot.currentTime);
				}
			},
			onLiveChanged: (unit: PlayerUnit, isLive: boolean) => {
				const video = unit.currentVideo;
				if (!video || video.isLive === isLive) return;
				const updated = { ...video, isLive };
				const index = this.videos.findIndex((item) => sameVideo(item, video));
				if (index >= 0) this.videos[index] = updated;
				unit.updateVideo(updated);
				if (unit === this.activeUnit()) this.overlay.setVideo(updated);
			},
			onMutedChanged: (unit: PlayerUnit, muted: boolean) => {
				if (unit === this.activeUnit()) this.overlay.setMuted(muted);
			}
		};
	}

	private gestureCallbacks() {
		return {
			getCurrentTime: () => this.activeUnit().getSnapshot().currentTime,
			getSeekMax: () => this.activeUnit().getSnapshot().seekMax,
			seekDirect: (time: number) => this.activeUnit().seek(time, false),
			finishSeek: () => void this.activeUnit().play(),
			onVerticalStart: () => this.beginUnsettled(),
			setControlsVisible: (visible: boolean) => this.setControlsVisible(visible),
			applyZoom: (scale: number, x: number, y: number) => this.activeUnit().applyZoom(scale, x, y),
			resetZoom: () => this.activeUnit().resetZoom()
		};
	}

	private loadEdgeUnits(): void {
		const targets = [
			this.videos[this.currentIndex - 1],
			this.videos[this.currentIndex],
			this.videos[this.currentIndex + 1]
		];
		for (const [position, unit] of this.units.entries()) {
			const video = targets[position];
			if (!video) {
				unit.clear();
				continue;
			}
			if (unit.currentVideo && sameVideo(unit.currentVideo, video)) {
				unit.updateVideo(video);
				continue;
			}
			void unit.load(video, savedTime(video), true);
		}
	}

	private activateCurrent(): void {
		for (const [position, unit] of this.units.entries()) {
			unit.setActive(position === 1);
			void unit.play();
		}
		const video = this.current();
		const active = this.activeUnit();
		this.overlay.setVideo(video);
		this.overlay.setTimeline(overlayTimeline(active.getSnapshot()));
		this.overlay.setMuted(active.video.muted);
		this.overlay.setSegments(this.segments);
		this.overlay.setMembership(this.membership);
		this.overlay.setUiVisible(this.controlsVisible);
		this.overlay.setInteractive(!this.unsettled);
		document.title = `${video.filename} - ${this.provider} - Video Editor`;
		history.replaceState(null, '', videoUrl(video));
		sessionStorage.setItem(STORAGE_KEYS.HIGHLIGHT_PREFIX + this.provider, video.filename);
		void this.loadMembership();
	}

	private readonly handleScroll = (): void => {
		if (this.programmaticScroll) return;
		this.beginUnsettled();
	};

	private beginUnsettled(): void {
		if (this.unsettled) return;
		this.unsettled = true;
		this.activeUnit().resetZoom();
		this.overlay.setInteractive(false);
	}

	private readonly handleScrollEnd = (): void => {
		if (this.ignoreNextScrollEnd) {
			this.ignoreNextScrollEnd = false;
			return;
		}
		if (this.settlementTimer !== null) clearTimeout(this.settlementTimer);
		this.settlementTimer = window.setTimeout(() => {
			this.settlementTimer = null;
			this.settleFocusedVideo();
		}, SETTLEMENT_DELAY_MS);
	};

	private settleFocusedVideo(): void {
		const scores = this.units.map((unit) => visibleFraction(unit.video));
		const currentScore = scores[1];
		const bestScore = Math.max(...scores);
		const winners = scores.filter((score) => Math.abs(score - bestScore) < 0.000001);
		const winner = scores.findIndex((score) => Math.abs(score - bestScore) < 0.000001);

		if (winners.length === 1 && winner !== 1 && bestScore > currentScore) {
			const direction = winner === 0 ? -1 : 1;
			const target = this.currentIndex + direction;
			if (target >= 0 && target < this.videos.length) {
				this.commitScope(direction, target);
				return;
			}
		}
		this.unsettled = false;
		this.overlay.setInteractive(true);
	}

	private commitScope(direction: -1 | 1, targetIndex: number): void {
		const oldActive = this.activeUnit();
		this.saveProgress(oldActive.getSnapshot().currentTime);
		const selected = direction === 1 ? this.units[2] : this.units[0];
		const beforeTop = selected.video.getBoundingClientRect().top;

		this.units =
			direction === 1
				? [this.units[1], this.units[2], this.units[0]]
				: [this.units[2], this.units[0], this.units[1]];
		this.currentIndex = targetIndex;
		this.segments = [];
		this.applyScopeRoles();

		const afterTop = this.activeUnit().video.getBoundingClientRect().top;
		this.correctScroll(afterTop - beforeTop);
		this.loadEdgeUnits();
		this.unsettled = false;
		this.activateCurrent();
	}

	private applyScopeRoles(): void {
		for (const [position, unit] of this.units.entries()) {
			unit.wrapper.classList.remove('previous-scope', 'current-scope', 'next-scope');
			unit.wrapper.classList.add(
				position === 0 ? 'previous-scope' : position === 1 ? 'current-scope' : 'next-scope'
			);
			this.stage.append(unit.wrapper);
		}
	}

	private correctScroll(delta: number): void {
		if (Math.abs(delta) < 0.5) return;
		this.ignoreNextScrollEnd = true;
		this.programmaticScroll = true;
		window.scrollBy(0, delta);
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				this.programmaticScroll = false;
			});
		});
	}

	private centerVideo(video: HTMLVideoElement): void {
		const viewport = visualViewport;
		const viewportCenter = viewport
			? viewport.offsetTop + viewport.height / 2
			: window.innerHeight / 2;
		const rect = video.getBoundingClientRect();
		window.scrollBy(0, rect.top + rect.height / 2 - viewportCenter);
	}

	private setControlsVisible(visible: boolean): void {
		this.controlsVisible = visible;
		this.overlay.setUiVisible(visible);
	}

	private activeUnit(): PlayerUnit {
		return this.units[1];
	}

	private toggleMuteOrUndo(): void {
		if (this.segments.length > 0) {
			this.segments = this.segments.slice(0, -1);
			this.syncSegments();
			return;
		}
		this.activeUnit().toggleMute();
	}

	private addMarker(): void {
		const video = this.current();
		if (video.type !== VIDEO_TYPE.ORIGINAL || this.activeUnit().getSnapshot().isLive) return;
		this.segments = [...this.segments, this.activeUnit().getSnapshot().currentTime].sort(
			(a, b) => a - b
		);
		this.syncSegments();
	}

	private syncSegments(): void {
		this.overlay.setSegments(this.segments);
	}

	private async saveOrCut(playbackDuration: number): Promise<void> {
		const video = this.current();
		if (video.type !== VIDEO_TYPE.ORIGINAL) return;
		try {
			if (this.segments.length === 0) {
				await saveVideo(video);
			} else {
				if (this.segments.length % 2 !== 0) return;
				const playlist = await fetchPlaylist(video);
				const keep = calculateSegmentsToKeep(playlist.segments, this.segments, playbackDuration);
				await editVideo(video, keep);
			}
			this.segments = [];
			await this.replaceCurrent({ ...video, type: VIDEO_TYPE.EDITED });
		} catch (error) {
			this.handleMutationError(error);
		}
	}

	private async returnOriginal(): Promise<void> {
		const video = this.current();
		if (video.type !== VIDEO_TYPE.EDITED) return;
		try {
			await returnVideo(video);
			await this.replaceCurrent({ ...video, type: VIDEO_TYPE.ORIGINAL });
		} catch (error) {
			this.handleMutationError(error);
		}
	}

	private async replaceCurrent(video: Video): Promise<void> {
		this.videos[this.currentIndex] = video;
		this.syncSegments();
		history.replaceState(null, '', videoUrl(video));
		await this.activeUnit().load(video, 0, true);
		this.activateCurrent();
	}

	private handleMutationError(error: unknown): void {
		console.error(error);
		if (error instanceof ApiError && error.status === 404) {
			this.videos.splice(this.currentIndex, 1);
			if (this.videos.length === 0) {
				history.back();
				return;
			}
			this.currentIndex = Math.min(this.currentIndex, this.videos.length - 1);
			this.loadEdgeUnits();
			this.activateCurrent();
		}
	}

	private async loadMembership(): Promise<void> {
		const video = this.current();
		const token = ++this.membershipToken;
		this.setMembership({ state: 'loading' });
		try {
			const identifiers = await fetchMembership(this.provider);
			if (token !== this.membershipToken || this.current() !== video) return;
			this.setMembership({
				state: 'ready',
				isMember: identifiers.has(extractIdentifier(video.filename))
			});
		} catch (error) {
			if (token !== this.membershipToken) return;
			this.setMembership({
				state: 'error',
				confirmedMember: false,
				message: error instanceof Error ? error.message : 'Membership fetch failed'
			});
		}
	}

	private async toggleMembership(): Promise<void> {
		if (this.membership.state !== 'ready' && this.membership.state !== 'error') return;
		const confirmed =
			this.membership.state === 'ready'
				? this.membership.isMember
				: this.membership.confirmedMember;
		const video = this.current();
		const token = ++this.membershipToken;
		this.setMembership(
			confirmed
				? { state: 'removing', confirmedMember: true }
				: { state: 'adding', confirmedMember: false }
		);
		try {
			await changeMembership(this.provider, extractIdentifier(video.filename), !confirmed);
			const identifiers = await fetchMembership(this.provider);
			if (token !== this.membershipToken || this.current() !== video) return;
			this.setMembership({
				state: 'ready',
				isMember: identifiers.has(extractIdentifier(video.filename))
			});
		} catch (error) {
			if (token !== this.membershipToken) return;
			this.setMembership({
				state: 'error',
				confirmedMember: confirmed,
				message: error instanceof Error ? error.message : 'Membership update failed'
			});
		}
	}

	private setMembership(state: MembershipState): void {
		this.membership = state;
		this.overlay.setMembership(state);
	}

	private saveProgress(time: number): void {
		const video = this.current();
		if (!Number.isFinite(time)) return;
		localStorage.setItem(STORAGE_KEYS.PROGRESS_PREFIX + video.filename, String(time));
	}

	private readonly handlePageHide = (): void => {
		this.saveProgress(this.activeUnit().getSnapshot().currentTime);
		void this.releaseWakeLock();
	};

	private readonly handlePageShow = (event: PageTransitionEvent): void => {
		if (!event.persisted) return;
		this.resumeAll();
		void this.requestWakeLock();
	};

	private readonly handleVisibility = (): void => {
		if (document.visibilityState === 'hidden') {
			this.saveProgress(this.activeUnit().getSnapshot().currentTime);
		} else {
			this.resumeAll();
			void this.requestWakeLock();
		}
	};

	private readonly handleOnline = (): void => {
		this.resumeAll();
	};

	private resumeAll(): void {
		for (const unit of this.units) unit.resume();
	}

	private wakeLock: WakeLockSentinel | null = null;

	private async requestWakeLock(): Promise<void> {
		if (this.wakeLock || !('wakeLock' in navigator)) return;
		try {
			this.wakeLock = await navigator.wakeLock.request('screen');
		} catch (error) {
			console.warn('Wake lock failed', error);
		}
	}

	private async releaseWakeLock(): Promise<void> {
		await this.wakeLock?.release();
		this.wakeLock = null;
	}
}

function savedTime(video: Video): number {
	return Number.parseFloat(
		localStorage.getItem(STORAGE_KEYS.PROGRESS_PREFIX + video.filename) ?? '0'
	);
}

function sameVideo(first: Video, second: Video): boolean {
	return first.filename === second.filename && first.type === second.type;
}

function videoUrl(video: Video): string {
	return `/videos/${video.provider}/${encodeURIComponent(video.filename)}?type=${video.type}`;
}

function overlayTimeline(snapshot: TimelineSnapshot): OverlayTimeline {
	return {
		currentTime: snapshot.currentTime,
		duration: snapshot.duration,
		seekableEnd: snapshot.seekableEnd ?? 0,
		currentSegmentName: snapshot.currentSegmentName,
		isLive: snapshot.isLive
	};
}

function visibleFraction(video: HTMLVideoElement): number {
	if (video.hidden || video.getClientRects().length === 0) return -1;
	const rect = video.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return -1;
	const viewport = visualViewport;
	const top = viewport?.offsetTop ?? 0;
	const left = viewport?.offsetLeft ?? 0;
	const right = left + (viewport?.width ?? innerWidth);
	const bottom = top + (viewport?.height ?? innerHeight);
	const visibleWidth = Math.max(0, Math.min(rect.right, right) - Math.max(rect.left, left));
	const visibleHeight = Math.max(0, Math.min(rect.bottom, bottom) - Math.max(rect.top, top));
	return (visibleWidth * visibleHeight) / (rect.width * rect.height);
}
