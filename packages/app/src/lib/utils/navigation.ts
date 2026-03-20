import { STORAGE_KEYS } from '../constants.js';
import type { Video } from '../types.js';

export function findAdjacentVideo(
	cv: Video,
	filteredList: Video[],
	direction: 1 | -1
): Video | null {
	if (filteredList.length < 2) return null;
	const idx = filteredList.findIndex(
		(v) => v.filename === cv.filename && v.type === cv.type
	);
	if (idx === -1) return null;
	for (let i = idx + direction; i >= 0 && i < filteredList.length; i += direction) {
		if (filteredList[i].filename !== cv.filename) return filteredList[i];
	}
	return null;
}

export function getSavedTime(v: Video): number {
	return parseFloat(localStorage.getItem(STORAGE_KEYS.PROGRESS_PREFIX + v.filename) || '0');
}
