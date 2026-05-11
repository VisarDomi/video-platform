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
	durationSource: 'playlist' | 'seekable' | 'media' | 'none' | 'live';
	seekMax: number;
	isLive: boolean;
	mediaDuration: number | null;
	seekableEnd: number | null;
	ended: boolean;
	playlistTime: number | null;
	currentSegmentName: string | null;
	currentSegmentStart: number | null;
	currentSegmentEnd: number | null;
	playbackToPlaylistScale: number;
}

export interface NativeEndedAssessment {
	verdict: 'confirmed' | 'rejected';
	reason: 'live-ended' | 'no-playlist-authority' | 'playlist-ended' | 'playlist-not-exhausted';
	currentTime: number;
	playlistTime: number | null;
	terminalTime: number;
	remaining: number;
	duration: number;
	durationSource: TimelineSnapshot['durationSource'];
	mediaDuration: number | null;
	seekableEnd: number | null;
	currentSegmentName: string | null;
	currentSegmentStart: number | null;
	currentSegmentEnd: number | null;
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
		const currentTruth = this.playlistTruth;
		const shouldPreserveSegmentDuration =
			!playlistTruth.isLive &&
			!playlistTruth.segments &&
			currentTruth?.segments &&
			!currentTruth.isLive &&
			currentTruth.totalDuration > 0;
		this.playlistTruth = {
			...playlistTruth,
			totalDuration: shouldPreserveSegmentDuration ? currentTruth.totalDuration : playlistTruth.totalDuration,
			segments: playlistTruth.segments ?? currentTruth?.segments
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
				durationSource: 'live',
				seekMax,
				isLive: true,
				mediaDuration,
				seekableEnd,
				ended: this.media.ended,
				playlistTime: null,
				currentSegmentName: null,
				currentSegmentStart: null,
				currentSegmentEnd: null,
				playbackToPlaylistScale: 1
			};
		}

		const durationTruth = this.resolveVodDuration(mediaDuration, seekableEnd);
		const resolvedDuration = durationTruth.duration;

		const playlistPosition = this.resolvePlaylistPosition(currentTime, resolvedDuration);

		return {
			currentTime,
			duration: resolvedDuration,
			durationSource: durationTruth.source,
			seekMax: resolvedDuration,
			isLive: false,
			mediaDuration,
			seekableEnd,
			ended: this.media.ended,
			playlistTime: playlistPosition.playlistTime,
			currentSegmentName: playlistPosition.segment?.name ?? null,
			currentSegmentStart: playlistPosition.segment?.start ?? null,
			currentSegmentEnd: playlistPosition.segment?.end ?? null,
			playbackToPlaylistScale: playlistPosition.scale
		};
	}

	clampSeekTarget(time: number): number {
		const { seekMax } = this.snapshot();
		return Math.max(0, Math.min(time, seekMax));
	}

	assessNativeEnded(): NativeEndedAssessment {
		const snapshot = this.snapshot();
		const terminalTime =
			snapshot.seekableEnd !== null && snapshot.seekableEnd > 0
				? Math.min(snapshot.seekMax, snapshot.seekableEnd)
				: snapshot.seekMax;
		const remaining = terminalTime - snapshot.currentTime;
		const base = {
			currentTime: snapshot.currentTime,
			playlistTime: snapshot.playlistTime,
			terminalTime,
			remaining,
			duration: snapshot.duration,
			durationSource: snapshot.durationSource,
			mediaDuration: snapshot.mediaDuration,
			seekableEnd: snapshot.seekableEnd,
			currentSegmentName: snapshot.currentSegmentName,
			currentSegmentStart: snapshot.currentSegmentStart,
			currentSegmentEnd: snapshot.currentSegmentEnd
		};

		if (snapshot.isLive) {
			return { verdict: 'confirmed', reason: 'live-ended', ...base };
		}
		if (snapshot.durationSource !== 'playlist' && snapshot.durationSource !== 'seekable') {
			return { verdict: 'confirmed', reason: 'no-playlist-authority', ...base };
		}
		if (remaining > 0) {
			return { verdict: 'rejected', reason: 'playlist-not-exhausted', ...base };
		}
		return { verdict: 'confirmed', reason: 'playlist-ended', ...base };
	}

	private resolvePlaylistPosition(
		playbackTime: number,
		playbackDuration: number
	): { playlistTime: number | null; segment: PlaylistSegmentTruth | null; scale: number } {
		const truth = this.playlistTruth;
		const segments = truth?.segments;
		if (!truth || !segments || segments.length === 0 || truth.totalDuration <= 0) {
			return { playlistTime: null, segment: null, scale: 1 };
		}

		const scale = playbackDuration > 0 ? truth.totalDuration / playbackDuration : 1;
		const playlistTime = Math.max(0, Math.min(playbackTime * scale, truth.totalDuration));
		const segment = this.findSegmentAt(segments, playlistTime, truth.totalDuration);

		return {
			playlistTime,
			segment,
			scale
		};
	}

	private resolveVodDuration(
		mediaDuration: number | null,
		seekableEnd: number | null
	): { duration: number; source: TimelineSnapshot['durationSource'] } {
		const declaredDuration = this.playlistTruth?.totalDuration ?? 0;
		if (declaredDuration > 0) {
			return { duration: declaredDuration, source: 'playlist' };
		}
		if (seekableEnd !== null && seekableEnd > 0) {
			return { duration: seekableEnd, source: 'seekable' };
		}
		if (mediaDuration !== null && mediaDuration > 0) {
			return { duration: mediaDuration, source: 'media' };
		}
		return { duration: 0, source: 'none' };
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
