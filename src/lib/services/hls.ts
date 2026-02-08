import { API, HLS } from '../constants.js';
import type { Video } from '../types.js';

export interface PlaylistSegment {
	name: string;
	duration: number;
}

export interface PlaylistData {
	segments: PlaylistSegment[];
	isLive: boolean;
}

const cache = new Map<string, PlaylistData>();

export async function fetchAndParsePlaylist(video: Video): Promise<PlaylistData | null> {
	if (cache.has(video.filename)) {
		return cache.get(video.filename)!;
	}

	const response = await fetch(API.HLS_PLAYLIST(video.filename));
	const text = await response.text();

	const isLive = !text.includes('#EXT-X-ENDLIST');

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

	const data: PlaylistData = { segments, isLive };
	cache.set(video.filename, data);
	return data;
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
