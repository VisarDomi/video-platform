export interface PlaylistTruth {
	totalDuration: number;
	isLive: boolean;
	segments?: PlaylistSegmentTruth[];
}

export interface PlaylistSegmentTruth {
	name: string;
	start: number;
	end: number;
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
	playlistTime: number | null;
	currentSegmentName: string | null;
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
		this.playlistTruth = {
			...playlistTruth,
			segments: playlistTruth.segments ?? this.playlistTruth?.segments
		};
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
				ended: this.media.ended,
				playlistTime: null,
				currentSegmentName: null
			};
		}

		const declaredDuration = this.playlistTruth?.totalDuration ?? 0;
		const fallbackDuration = declaredDuration > 0 ? declaredDuration : seekableEnd ?? 0;
		const resolvedDuration = mediaDuration ?? fallbackDuration;

		const playlistPosition = this.resolvePlaylistPosition(currentTime, resolvedDuration);

		return {
			currentTime,
			duration: resolvedDuration,
			seekMax: resolvedDuration,
			isLive: false,
			mediaDuration,
			seekableEnd,
			ended: this.media.ended,
			playlistTime: playlistPosition.playlistTime,
			currentSegmentName: playlistPosition.segmentName
		};
	}

	clampSeekTarget(time: number): number {
		const { seekMax } = this.snapshot();
		return Math.max(0, Math.min(time, seekMax));
	}

	private resolvePlaylistPosition(
		playbackTime: number,
		playbackDuration: number
	): { playlistTime: number | null; segmentName: string | null } {
		const truth = this.playlistTruth;
		const segments = truth?.segments;
		if (!truth || !segments || segments.length === 0 || truth.totalDuration <= 0) {
			return { playlistTime: null, segmentName: null };
		}

		const scale = playbackDuration > 0 ? truth.totalDuration / playbackDuration : 1;
		const playlistTime = Math.max(0, Math.min(playbackTime * scale, truth.totalDuration));
		const segment = this.findSegmentAt(segments, playlistTime, truth.totalDuration);

		return {
			playlistTime,
			segmentName: segment?.name ?? null
		};
	}

	private findSegmentAt(
		segments: PlaylistSegmentTruth[],
		playlistTime: number,
		totalDuration: number
	): PlaylistSegmentTruth | null {
		if (playlistTime >= totalDuration) return segments[segments.length - 1] ?? null;

		let low = 0;
		let high = segments.length - 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const segment = segments[mid];
			if (playlistTime < segment.start) {
				high = mid - 1;
			} else if (playlistTime >= segment.end) {
				low = mid + 1;
			} else {
				return segment;
			}
		}

		return null;
	}
}
