import { API } from '../constants.js';
import type { Video } from '../types.js';

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

export async function fetchPlaylist(video: Video): Promise<PlaylistData> {
	const response = await fetch(API.HLS_PLAYLIST(video.provider, video.filename));
	if (!response.ok) throw new Error(`Playlist fetch failed: ${response.status}`);
	const text = await response.text();
	const lines = text.split('\n');
	const segments: PlaylistSegment[] = [];
	let elapsed = 0;
	for (let index = 0; index < lines.length; index++) {
		if (!lines[index].startsWith('#EXTINF:')) continue;
		const duration = Number.parseFloat(lines[index].slice('#EXTINF:'.length));
		const name = lines[index + 1]?.trim();
		if (!name?.endsWith('.ts')) continue;
		const start = elapsed;
		elapsed += duration;
		segments.push({ name, duration, start, end: elapsed });
	}
	return {
		segments,
		isLive: !text.includes('#EXT-X-ENDLIST'),
		isFmp4: text.includes('#EXT-X-MAP:')
	};
}

export function calculateSegmentsToKeep(
	videoSegments: readonly PlaylistSegment[],
	markers: readonly number[],
	playbackDuration: number
): string[] {
	const totalDuration = videoSegments.reduce((total, segment) => Math.max(total, segment.end), 0);
	const scale = playbackDuration > 0 && totalDuration > 0 ? totalDuration / playbackDuration : 1;
	const keep = new Set<string>();
	for (let index = 0; index < markers.length; index += 2) {
		const start = markers[index] * scale;
		const end = markers[index + 1] * scale;
		for (const segment of videoSegments) {
			if (segment.start < end && segment.end > start) keep.add(segment.name);
		}
	}
	return [...keep];
}
