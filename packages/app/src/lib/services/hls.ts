import { API, HLS } from '../constants.js';
import type { Video } from '../types.js';
import { logService } from './LogService.js';

export interface PlaylistSegment {
	name: string;
	duration: number;
	start: number;
	end: number;
}

export interface PlaylistData {
	segments: PlaylistSegment[];
	isLive: boolean;
	isFmp4: boolean;
}

export async function fetchAndParsePlaylist(video: Video): Promise<PlaylistData | null> {
	const start = performance.now();
	const response = await fetch(API.HLS_PLAYLIST(video.provider, video.filename));
	const text = await response.text();
	const fetchMs = performance.now() - start;

	const isLive = !text.includes('#EXT-X-ENDLIST');
	const isFmp4 = text.includes('#EXT-X-MAP:');

	const lines = text.split('\n');
	const segments: PlaylistSegment[] = [];
	let cumulativeTime = 0;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(HLS.EXTINF_PREFIX)) {
			const duration = parseFloat(lines[i].split(':')[1]);
			const name = lines[i + 1].trim();
			if (name.endsWith(HLS.TS_EXTENSION)) {
				const startTime = cumulativeTime;
				cumulativeTime += duration;
				segments.push({ name, duration, start: startTime, end: cumulativeTime });
			}
		}
	}

	const totalDuration = cumulativeTime;
	const firstSegment = segments[0]?.name ?? null;
	const lastSegment = segments[segments.length - 1]?.name ?? null;

	logService.emit('playlist-fetch', {
		filename: video.filename,
		fetchMs: Math.round(fetchMs),
		segments: segments.length,
		isLive,
		isFmp4,
		bytes: text.length,
		totalDuration,
		firstSegment,
		lastSegment
	});

	return { segments, isLive, isFmp4 };
}

export function calculateSegmentsToKeep(
	videoSegments: PlaylistSegment[],
	timeSegments: readonly number[],
	filename: string,
	playbackDuration?: number
): string[] {
	const segmentsToKeep = new Set<string>();
	let cumulativeTime = 0;
	const tsFileDurations = videoSegments.map((s) => {
		if (Number.isFinite(s.start) && Number.isFinite(s.end)) {
			cumulativeTime = Math.max(cumulativeTime, s.end);
			return s;
		}
		const start = cumulativeTime;
		cumulativeTime += s.duration;
		return { name: s.name, duration: s.duration, start, end: cumulativeTime };
	});
	const playlistDuration = cumulativeTime;
	const shouldMapPlaybackTime =
		typeof playbackDuration === 'number' &&
		Number.isFinite(playbackDuration) &&
		playbackDuration > 0 &&
		playlistDuration > 0;
	const playbackToPlaylistScale = shouldMapPlaybackTime ? playlistDuration / playbackDuration : 1;
	const scaledRanges: Array<{ start: number; end: number }> = [];

	for (let i = 0; i < timeSegments.length; i += 2) {
		const rangeStart = timeSegments[i] * playbackToPlaylistScale;
		const rangeEnd = timeSegments[i + 1] * playbackToPlaylistScale;
		scaledRanges.push({
			start: Number(rangeStart.toFixed(3)),
			end: Number(rangeEnd.toFixed(3))
		});
		for (const tsFile of tsFileDurations) {
			if (tsFile.start < rangeEnd && tsFile.end > rangeStart) {
				segmentsToKeep.add(tsFile.name);
			}
		}
	}

	const result = Array.from(segmentsToKeep);

	logService.emit('edit-segments-calculated', {
		filename,
		totalPlaylistSegments: videoSegments.length,
		timeRanges: timeSegments.length / 2,
		totalDuration: Math.round(playlistDuration),
		playbackDuration: shouldMapPlaybackTime ? playbackDuration : null,
		playbackToPlaylistScale,
		markerTimes: timeSegments.map((time) => Number(time.toFixed(3))),
		scaledRanges,
		segmentsToKeep: result.length,
		firstKept: result[0] ?? null,
		lastKept: result[result.length - 1] ?? null,
	});

	return result;
}
