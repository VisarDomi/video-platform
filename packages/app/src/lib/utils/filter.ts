import type { Video } from '../types.js';
import { extractAlias } from './alias.js';

export function filterByAliases(videos: Video[], selectedAliases: Set<string>): Video[] {
	if (selectedAliases.size === 0) return videos;
	return videos.filter((v) => selectedAliases.has(extractAlias(v.filename)));
}
