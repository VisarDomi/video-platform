import { API, HLS } from '../constants.js';
import type { Video } from '../types.js';
import { logEvent } from './log.js';

export interface PlaylistSegment {
	name: string;
	duration: number;
}

export interface PlaylistData {
	segments: PlaylistSegment[];
	isLive: boolean;
	isFmp4: boolean;
}

export async function isFmp4Playlist(filename: string): Promise<boolean> {
	try {
		const response = await fetch(API.HLS_PLAYLIST(filename));
		const text = await response.text();
		return text.includes('#EXT-X-MAP:');
	} catch {
		return false;
	}
}

export async function fetchAndParsePlaylist(video: Video): Promise<PlaylistData | null> {
	const start = performance.now();
	const response = await fetch(API.HLS_PLAYLIST(video.filename));
	const text = await response.text();
	const fetchMs = performance.now() - start;

	const isLive = !text.includes('#EXT-X-ENDLIST');
	const isFmp4 = text.includes('#EXT-X-MAP:');

	const lines = text.split('\n');
	const segments: PlaylistSegment[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(HLS.EXTINF_PREFIX)) {
			const duration = parseFloat(lines[i].split(':')[1]);
			const name = lines[i + 1].trim();
			if (name.endsWith(HLS.TS_EXTENSION)) {
				segments.push({ name, duration });
			}
		}
	}

	logEvent('playlist-fetch', {
		filename: video.filename,
		fetchMs: Math.round(fetchMs),
		segments: segments.length,
		isLive,
		isFmp4,
		bytes: text.length
	});

	return { segments, isLive, isFmp4 };
}

export function calculateSegmentsToKeep(
	videoSegments: PlaylistSegment[],
	timeSegments: readonly number[]
): string[] {
	const segmentsToKeep = new Set<string>();
	let cumulativeTime = 0;
	const tsFileDurations = videoSegments.map((s) => {
		const start = cumulativeTime;
		cumulativeTime += s.duration;
		return { name: s.name, start, end: cumulativeTime };
	});

	for (let i = 0; i < timeSegments.length; i += 2) {
		const rangeStart = timeSegments[i];
		const rangeEnd = timeSegments[i + 1];
		for (const tsFile of tsFileDurations) {
			if (tsFile.start < rangeEnd && tsFile.end > rangeStart) {
				segmentsToKeep.add(tsFile.name);
			}
		}
	}

	return Array.from(segmentsToKeep);
}
