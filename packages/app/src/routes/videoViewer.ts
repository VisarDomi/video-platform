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
import type { OverlayActions } from '../player/OverlayView.js';
import { PlayerUnit } from '../player/PlayerUnit.js';
import type { TimelineSnapshot } from '../player/PlaybackTimeline.js';
import type { Video, VideoType } from '../types.js';

const NAV_THRESHOLD = 0.2;
const NAV_MS = 220;
const PROGRESS_SAVE_MS = 3000;

export class VideoViewerPage {
	private readonly stage = document.createElement('main');
	private units: PlayerUnit[] = [];
	private videos: Video[] = [];
	private currentIndex = 0;
	private gesture!: GestureController;
	private segments: number[] = [];
	private controlsVisible = true;
	private moving = false;
	private lastProgressSave = 0;
	private membership: MembershipState = { state: 'loading' };
	private membershipToken = 0;

	constructor(
		private readonly provider: Provider,
		private readonly requestedFilename: string,
		private readonly requestedType: VideoType | null
	) {
		this.stage.className = 'video-stage';
	}

	async open(): Promise<void> {
		document.body.className = 'viewer-page';
		document.body.replaceChildren(status('Loading…'));
		this.videos = await fetchVideos(this.provider);
		this.currentIndex = this.findRequestedIndex();
		if (this.currentIndex < 0) throw new Error('Video not found.');

		this.units = [-1, 0, 1].map(() => new PlayerUnit(this.actions(), this.unitCallbacks()));
		this.stage.append(...this.units.map((unit) => unit.wrapper));
		document.body.replaceChildren(this.stage);
		this.resetUnitPositions();
		await this.updateUnits();
		this.activateCurrent();
		this.gesture = new GestureController(this.stage, this.gestureCallbacks());
		void this.requestWakeLock();

		addEventListener('pagehide', this.handlePageHide);
		addEventListener('pageshow', this.handlePageShow);
		document.addEventListener('visibilitychange', this.handleVisibility);
		addEventListener('online', this.handleOnline);
	}

	private findRequestedIndex(): number {
		return this.videos.findIndex(
			(video) =>
				video.filename === this.requestedFilename &&
				(this.requestedType === null || video.type === this.requestedType)
		);
	}

	private current(): Video {
		return this.videos[this.currentIndex];
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
			}
		};
	}

	private gestureCallbacks() {
		return {
			getCurrentTime: () => this.activeUnit().getSnapshot().currentTime,
			getSeekMax: () => this.activeUnit().getSnapshot().seekMax,
			seekDirect: (time: number) => this.activeUnit().seek(time, false),
			finishSeek: () => void this.activeUnit().play(),
			moveVertical: (delta: number) => this.moveVertical(delta),
			releaseVertical: (delta: number) => this.releaseVertical(delta),
			cancelVertical: () => this.cancelVertical(),
			setControlsVisible: (visible: boolean) => this.setControlsVisible(visible),
			applyZoom: (scale: number, x: number, y: number) => this.activeUnit().applyZoom(scale, x, y),
			resetZoom: () => this.activeUnit().resetZoom()
		};
	}

	private async updateUnits(): Promise<void> {
		const targets = [
			this.videos[this.currentIndex - 1],
			this.videos[this.currentIndex],
			this.videos[this.currentIndex + 1]
		];
		await Promise.all(
			this.units.map(async (unit, position) => {
				const video = targets[position];
				if (!video) {
					unit.clear();
					return;
				}
				const shouldPlay = position !== 0;
				await unit.load(video, savedTime(video), shouldPlay);
				if (position === 0) unit.video.pause();
			})
		);
	}

	private activateCurrent(): void {
		for (const [position, unit] of this.units.entries()) {
			unit.setActive(position === 1);
			unit.setUiVisible(this.controlsVisible);
			unit.setSegments(position === 1 ? this.segments : []);
		}
		const video = this.current();
		document.title = `${video.filename} - ${this.provider} - Video Editor`;
		history.replaceState(null, '', videoUrl(video));
		sessionStorage.setItem(STORAGE_KEYS.HIGHLIGHT_PREFIX + this.provider, video.filename);
		void this.activeUnit().play();
		void this.loadMembership();
	}

	private moveVertical(delta: number): void {
		if (this.moving) return;
		for (const [position, unit] of this.units.entries()) {
			unit.wrapper.style.transition = 'none';
			unit.wrapper.style.transform = `translateY(calc(${(position - 1) * 100}% + ${delta}px))`;
		}
	}

	private releaseVertical(delta: number): void {
		if (this.moving) return;
		const direction = delta < 0 ? 1 : -1;
		const target = this.currentIndex + direction;
		const commit = Math.abs(delta) > innerHeight * NAV_THRESHOLD && Boolean(this.videos[target]);
		this.moving = true;
		for (const [position, unit] of this.units.entries()) {
			unit.wrapper.style.transition = `transform ${NAV_MS}ms ease-out`;
			const destination = commit ? position - 1 - direction : position - 1;
			unit.wrapper.style.transform = `translateY(${destination * 100}%)`;
		}
		window.setTimeout(() => {
			if (!commit) {
				this.resetUnitPositions();
				return;
			}
			this.saveProgress(this.activeUnit().getSnapshot().currentTime);
			this.units =
				direction === 1
					? [this.units[1], this.units[2], this.units[0]]
					: [this.units[2], this.units[0], this.units[1]];
			this.currentIndex = target;
			this.segments = [];
			this.resetUnitPositions();
			void this.updateUnits().then(() => this.activateCurrent());
		}, NAV_MS);
	}

	private cancelVertical(): void {
		if (this.moving) return;
		this.moving = true;
		for (const [position, unit] of this.units.entries()) {
			unit.wrapper.style.transition = `transform ${NAV_MS}ms ease-out`;
			unit.wrapper.style.transform = `translateY(${(position - 1) * 100}%)`;
		}
		window.setTimeout(() => this.resetUnitPositions(), NAV_MS);
	}

	private resetUnitPositions(): void {
		this.moving = false;
		for (const [position, unit] of this.units.entries()) {
			unit.wrapper.style.transition = '';
			unit.wrapper.style.transform = `translateY(${(position - 1) * 100}%)`;
		}
	}

	private setControlsVisible(visible: boolean): void {
		this.controlsVisible = visible;
		for (const unit of this.units) unit.setUiVisible(visible);
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
		for (const [position, unit] of this.units.entries()) {
			unit.setSegments(position === 1 ? this.segments : []);
		}
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
			this.resetUnitPositions();
			void this.updateUnits().then(() => this.activateCurrent());
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
		this.activeUnit().setMembership(state);
	}

	private saveProgress(time: number): void {
		const video = this.current();
		if (!video || !Number.isFinite(time)) return;
		localStorage.setItem(STORAGE_KEYS.PROGRESS_PREFIX + video.filename, String(time));
	}

	private readonly handlePageHide = (): void => {
		this.saveProgress(this.activeUnit().getSnapshot().currentTime);
		void this.releaseWakeLock();
	};

	private readonly handlePageShow = (event: PageTransitionEvent): void => {
		if (!event.persisted) return;
		this.activeUnit().resume();
		void this.requestWakeLock();
	};

	private readonly handleVisibility = (): void => {
		if (document.visibilityState === 'hidden') {
			this.saveProgress(this.activeUnit().getSnapshot().currentTime);
		} else {
			this.activeUnit().resume();
			void this.requestWakeLock();
		}
	};

	private readonly handleOnline = (): void => {
		this.activeUnit().resume();
	};

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

function status(text: string): HTMLParagraphElement {
	const message = document.createElement('p');
	message.className = 'status';
	message.textContent = text;
	return message;
}
