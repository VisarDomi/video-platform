export interface PlaylistSegmentTruth {
	name: string;
	start: number;
	end: number;
}

export interface PlaylistTruth {
	totalDuration: number;
	isLive: boolean;
	segments?: PlaylistSegmentTruth[];
}

export interface TimelineSnapshot {
	currentTime: number;
	duration: number;
	seekMax: number;
	isLive: boolean;
	seekableEnd: number | null;
	currentSegmentName: string | null;
}

export class PlaybackTimeline {
	private playlist: PlaylistTruth | null = null;
	private currentTime = 0;
	private mediaDuration: number | null = null;
	private seekableEnd: number | null = null;
	private mediaIsLive = false;

	setPlaylistTruth(truth: PlaylistTruth): void {
		const previous = this.playlist;
		this.playlist = {
			...truth,
			segments: truth.segments ?? previous?.segments
		};
	}

	observe(video: HTMLVideoElement): void {
		this.currentTime = video.currentTime || 0;
		this.mediaDuration =
			Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
		this.seekableEnd =
			video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : null;
		this.mediaIsLive = video.duration === Infinity;
	}

	clear(): void {
		this.playlist = null;
		this.currentTime = 0;
		this.mediaDuration = null;
		this.seekableEnd = null;
		this.mediaIsLive = false;
	}

	snapshot(): TimelineSnapshot {
		const isLive = this.playlist?.isLive ?? this.mediaIsLive;
		if (isLive) {
			const seekMax = this.seekableEnd ?? this.mediaDuration ?? 0;
			return {
				currentTime: this.currentTime,
				duration: Infinity,
				seekMax,
				isLive: true,
				seekableEnd: this.seekableEnd,
				currentSegmentName: null
			};
		}

		const playlistDuration = this.playlist?.totalDuration ?? 0;
		const duration = playlistDuration || this.seekableEnd || this.mediaDuration || 0;
		const playlistTime =
			playlistDuration > 0 && duration > 0
				? Math.max(0, Math.min(this.currentTime * (playlistDuration / duration), playlistDuration))
				: null;
		return {
			currentTime: this.currentTime,
			duration,
			seekMax: duration,
			isLive: false,
			seekableEnd: this.seekableEnd,
			currentSegmentName:
				playlistTime === null ? null : (this.findSegment(playlistTime)?.name ?? null)
		};
	}

	clampSeekTarget(time: number): number {
		return Math.max(0, Math.min(time, this.snapshot().seekMax));
	}

	hasRemainingMedia(): boolean {
		const snapshot = this.snapshot();
		if (snapshot.isLive) return false;
		const terminal =
			snapshot.seekableEnd !== null && snapshot.seekableEnd > 0
				? Math.min(snapshot.seekableEnd, snapshot.seekMax)
				: snapshot.seekMax;
		return terminal - snapshot.currentTime > 0;
	}

	private findSegment(time: number): PlaylistSegmentTruth | null {
		const segments = this.playlist?.segments;
		if (!segments?.length) return null;
		if (time >= (this.playlist?.totalDuration ?? 0)) return segments[segments.length - 1];
		let low = 0;
		let high = segments.length - 1;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const segment = segments[middle];
			if (time < segment.start) high = middle - 1;
			else if (time >= segment.end) low = middle + 1;
			else return segment;
		}
		return null;
	}
}
