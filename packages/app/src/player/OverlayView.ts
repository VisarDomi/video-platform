import { VIDEO_TYPE } from '../constants.js';
import type { MembershipState } from '../services/downloadList.js';
import type { Video } from '../types.js';
import { formatTimePrecise } from '../utils/format.js';

export interface OverlayTimeline {
	currentTime: number;
	duration: number;
	seekableEnd: number;
	currentSegmentName: string | null;
	isLive: boolean;
}

export interface OverlayActions {
	onSeek(time: number): void;
	onSeekDirect(time: number): void;
	onToggleMuteOrUndo(): void;
	onToggleMembership(): void;
	onReturnOriginal(): void;
	onSaveOrCut(playbackDuration: number): void;
	onAddMarker(): void;
}

export class OverlayView {
	readonly element = document.createElement('div');
	private readonly name = element('div', 'streamer-name');
	private readonly time = element('span', 'time-display');
	private readonly segmentName = element('span', 'segment-display');
	private readonly progress = element('div', 'progress-bar');
	private readonly fill = element('div', 'progress-fill');
	private readonly markerLayer = element('div', 'marker-layer');
	private readonly segmentText = element('div', 'segment-text-container');
	private readonly muteUndo = button();
	private readonly membership = button();
	private readonly returnOriginal = button('🔄');
	private readonly saveCut = button();
	private readonly addMarker = button('📍');

	private video: Video | null = null;
	private timeline: OverlayTimeline = {
		currentTime: 0,
		duration: 0,
		seekableEnd: 0,
		currentSegmentName: null,
		isLive: false
	};
	private segments: readonly number[] = [];
	private membershipState: MembershipState = { state: 'loading' };
	private muted = true;
	private active = false;
	private uiVisible = true;
	private interactive = true;
	private scrubRect: DOMRect | null = null;
	private scrubRaf = 0;
	private pendingScrubX = 0;

	constructor(private readonly actions: OverlayActions) {
		this.element.className = 'player-overlay';
		const timeContainer = element('div', 'time-display-container');
		timeContainer.append(this.time, this.segmentName);
		this.progress.setAttribute('role', 'slider');
		this.progress.append(this.fill, this.markerLayer, this.segmentText);
		const controls = element('div', 'controls');
		const buttons = element('div', 'buttons');
		buttons.append(
			this.muteUndo,
			this.membership,
			this.returnOriginal,
			this.saveCut,
			this.addMarker
		);
		controls.append(buttons);
		this.element.append(this.name, timeContainer, this.progress, controls);

		this.muteUndo.addEventListener('click', actions.onToggleMuteOrUndo);
		this.membership.addEventListener('click', actions.onToggleMembership);
		this.returnOriginal.addEventListener('click', actions.onReturnOriginal);
		this.saveCut.addEventListener('click', () => actions.onSaveOrCut(this.effectiveDuration()));
		this.addMarker.addEventListener('click', actions.onAddMarker);
		this.progress.addEventListener('pointerdown', this.handlePointerDown);
		this.render();
	}

	setVideo(video: Video | null): void {
		this.video = video;
		this.render();
	}

	setTimeline(timeline: OverlayTimeline): void {
		this.timeline = timeline;
		this.renderTimeline();
		this.renderButtons();
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		this.renderButtons();
	}

	setActive(active: boolean): void {
		this.active = active;
		this.render();
	}

	setUiVisible(visible: boolean): void {
		this.uiVisible = visible;
		this.renderVisibility();
	}

	setInteractive(interactive: boolean): void {
		this.interactive = interactive;
		this.renderButtons();
	}

	setSegments(segments: readonly number[]): void {
		this.segments = segments;
		this.renderTimeline();
		this.renderButtons();
	}

	setMembership(state: MembershipState): void {
		this.membershipState = state;
		this.renderButtons();
	}

	destroy(): void {
		this.stopScrubbing();
		this.progress.removeEventListener('pointerdown', this.handlePointerDown);
	}

	private render(): void {
		this.name.textContent = this.video?.filename ?? '';
		this.renderVisibility();
		this.renderTimeline();
		this.renderButtons();
	}

	private renderVisibility(): void {
		const visible = this.uiVisible && this.active && this.video !== null;
		this.element.hidden = !visible;
	}

	private renderTimeline(): void {
		const duration = this.effectiveDuration();
		const percentage = duration > 0 ? (this.timeline.currentTime / duration) * 100 : 0;
		this.time.textContent = `${formatTimePrecise(this.timeline.currentTime)} / ${formatTimePrecise(duration)}`;
		this.segmentName.textContent = this.timeline.currentSegmentName ?? '';
		this.segmentName.hidden = this.timeline.currentSegmentName === null;
		this.fill.style.width = `${Math.max(0, Math.min(100, percentage))}%`;
		this.progress.setAttribute('aria-valuenow', String(this.timeline.currentTime));
		this.progress.setAttribute('aria-valuemin', '0');
		this.progress.setAttribute('aria-valuemax', String(duration));
		this.markerLayer.replaceChildren();
		this.segmentText.replaceChildren();
		if (!this.active || duration <= 0) return;

		for (const point of this.segments) {
			const marker = element('div', 'segment-marker');
			marker.style.left = `${(point / duration) * 100}%`;
			this.markerLayer.append(marker);
		}
		for (let index = 0; index < this.segments.length; index += 2) {
			const row = element('div', 'segment-row');
			const start = document.createElement('span');
			start.textContent = `start: ${formatTimePrecise(this.segments[index])}`;
			row.append(start);
			if (this.segments[index + 1] !== undefined) {
				const end = document.createElement('span');
				end.textContent = `end: ${formatTimePrecise(this.segments[index + 1])}`;
				row.append(end);
			}
			this.segmentText.append(row);
		}
	}

	private renderButtons(): void {
		const isOriginal = this.video?.type === VIDEO_TYPE.ORIGINAL && this.timeline.isLive === false;
		const isEdited = this.video?.type === VIDEO_TYPE.EDITED;
		const hasSegments = isOriginal && this.segments.length > 0;
		this.muteUndo.disabled = false;
		this.returnOriginal.disabled = false;
		this.addMarker.disabled = false;
		this.muteUndo.textContent = hasSegments ? '↪️' : this.muted ? '🔇' : '🔊';
		this.returnOriginal.hidden = !isEdited;
		this.saveCut.hidden = !isOriginal;
		this.addMarker.hidden = !isOriginal;
		this.saveCut.textContent = hasSegments ? '✂️' : '✅';
		this.saveCut.disabled = Boolean(hasSegments && this.segments.length % 2 !== 0);

		this.membership.disabled = false;
		this.membership.title = '';
		this.membership.classList.remove('list-add', 'list-remove', 'list-error');
		switch (this.membershipState.state) {
			case 'loading':
			case 'adding':
			case 'removing':
				this.membership.textContent = '⏳';
				this.membership.disabled = true;
				break;
			case 'ready':
				this.renderConfirmedMembership(this.membershipState.isMember);
				break;
			case 'error':
				this.renderConfirmedMembership(this.membershipState.confirmedMember);
				this.membership.classList.add('list-error');
				this.membership.title = this.membershipState.message;
				break;
		}
		if (!this.interactive) {
			for (const control of [
				this.muteUndo,
				this.membership,
				this.returnOriginal,
				this.saveCut,
				this.addMarker
			]) {
				control.disabled = true;
			}
		}
	}

	private renderConfirmedMembership(isMember: boolean): void {
		this.membership.textContent = isMember ? '➖' : '➕';
		this.membership.classList.add(isMember ? 'list-remove' : 'list-add');
	}

	private effectiveDuration(): number {
		const value =
			this.timeline.duration === Infinity && this.timeline.seekableEnd > 0
				? this.timeline.seekableEnd
				: this.timeline.duration;
		return Number.isFinite(value) && value > 0 ? value : 0;
	}

	private readonly handlePointerDown = (event: PointerEvent): void => {
		if (!this.active || !this.interactive) return;
		event.stopPropagation();
		this.scrubRect = this.progress.getBoundingClientRect();
		this.actions.onSeek(this.timeFromX(event.clientX));
		addEventListener('pointermove', this.handlePointerMove);
		addEventListener('pointerup', this.handlePointerUp, { once: true });
	};

	private readonly handlePointerMove = (event: PointerEvent): void => {
		if (!this.scrubRect) return;
		this.pendingScrubX = event.clientX;
		if (this.scrubRaf === 0) this.scrubRaf = requestAnimationFrame(this.flushScrub);
	};

	private readonly flushScrub = (): void => {
		this.scrubRaf = 0;
		if (this.scrubRect) this.actions.onSeekDirect(this.timeFromX(this.pendingScrubX));
	};

	private readonly handlePointerUp = (event: PointerEvent): void => {
		if (this.scrubRect) this.actions.onSeek(this.timeFromX(event.clientX));
		this.stopScrubbing();
	};

	private stopScrubbing(): void {
		this.scrubRect = null;
		if (this.scrubRaf !== 0) cancelAnimationFrame(this.scrubRaf);
		this.scrubRaf = 0;
		removeEventListener('pointermove', this.handlePointerMove);
		removeEventListener('pointerup', this.handlePointerUp);
	}

	private timeFromX(clientX: number): number {
		const rect = this.scrubRect;
		const duration = this.effectiveDuration();
		if (!rect || duration <= 0) return 0;
		const x = Math.max(0, Math.min(clientX - rect.left, rect.width));
		return duration * (x / rect.width);
	}
}

function element<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className: string
): HTMLElementTagNameMap[K] {
	const value = document.createElement(tag);
	value.className = className;
	return value;
}

function button(text = ''): HTMLButtonElement {
	const value = document.createElement('button');
	value.type = 'button';
	value.textContent = text;
	return value;
}
