export interface PlaylistTruth {
	totalDuration: number;
	isLive: boolean;
}

export interface MediaObservation {
	currentTime: number;
	duration: number | null;
	seekableEnd: number | null;
	isLive: boolean;
	ended: boolean;
}

export interface TimelineSnapshot {
	currentTime: number;
	duration: number;
	seekMax: number;
	isLive: boolean;
	mediaDuration: number | null;
	seekableEnd: number | null;
	ended: boolean;
}

export class PlaybackTimeline {
	private playlistTruth: PlaylistTruth | null = null;
	private media: MediaObservation = {
		currentTime: 0,
		duration: null,
		seekableEnd: null,
		isLive: false,
		ended: false
	};

	setPlaylistTruth(playlistTruth: PlaylistTruth): void {
		this.playlistTruth = playlistTruth;
	}

	clear(): void {
		this.playlistTruth = null;
		this.media = {
			currentTime: 0,
			duration: null,
			seekableEnd: null,
			isLive: false,
			ended: false
		};
	}

	observeMedia(media: MediaObservation): void {
		this.media = media;
	}

	getPlaylistTruth(): PlaylistTruth | null {
		return this.playlistTruth;
	}

	snapshot(): TimelineSnapshot {
		const currentTime = this.media.currentTime;
		const mediaDuration = this.media.duration;
		const seekableEnd = this.media.seekableEnd;

		if (this.playlistTruth?.isLive || (!this.playlistTruth && this.media.isLive)) {
			const seekMax = seekableEnd ?? mediaDuration ?? 0;
			return {
				currentTime,
				duration: Number.POSITIVE_INFINITY,
				seekMax,
				isLive: true,
				mediaDuration,
				seekableEnd,
				ended: this.media.ended
			};
		}

		const declaredDuration = this.playlistTruth?.totalDuration ?? 0;
		const resolvedDuration = Math.max(
			declaredDuration,
			seekableEnd ?? 0,
			mediaDuration ?? 0
		);

		return {
			currentTime,
			duration: resolvedDuration,
			seekMax: resolvedDuration,
			isLive: false,
			mediaDuration,
			seekableEnd,
			ended: this.media.ended
		};
	}

	clampSeekTarget(time: number): number {
		const { seekMax } = this.snapshot();
		return Math.max(0, Math.min(time, seekMax));
	}
}
