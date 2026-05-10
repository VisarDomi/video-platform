import { videoListStore } from '../stores/videoList.svelte.js';
import { playerStore } from '../stores/player.svelte.js';
import { VIDEO_TYPE } from '../constants.js';
import { sendSaveRequest, sendEditRequest, sendReturnRequest, ApiError } from './api.js';
import { fetchAndParsePlaylist, calculateSegmentsToKeep } from './hls.js';
import { logService } from './LogService.js';

export function saveCurrentVideo() {
	const video = playerStore.currentVideo;
	if (!video || video.type !== VIDEO_TYPE.ORIGINAL || playerStore.segments.length > 0) return;

	const filename = video.filename;
	videoListStore.updateVideoType(filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);
	playerStore.setLastActioned(filename);

	sendSaveRequest(video, video.provider).catch((err) => {
		if (err instanceof ApiError && err.status === 404) {
			videoListStore.removeVideo(filename);
			playerStore.showList();
			return;
		}
		videoListStore.updateVideoType(filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
	});
}

export async function createEditedVideo(playbackDuration?: number) {
	const video = playerStore.currentVideo;
	const timeSegments = playerStore.segments;
	if (
		!video ||
		video.type !== VIDEO_TYPE.ORIGINAL ||
		timeSegments.length === 0 ||
		timeSegments.length % 2 !== 0
	)
		return;

	const playlistData = await fetchAndParsePlaylist(video);
	if (!playlistData) {
		logService.emit('edit-playlist-fetch-failed', { filename: video.filename });
		return;
	}

	logService.emit('edit-begin', {
		filename: video.filename,
		isFmp4: playlistData.isFmp4,
		playlistSegments: playlistData.segments.length,
		timeMarkers: timeSegments.length,
	});

	const segmentsToSave = calculateSegmentsToKeep(
		playlistData.segments,
		timeSegments,
		video.filename,
		playbackDuration
	);
	const filename = video.filename;

	playerStore.clearSegments();
	videoListStore.updateVideoType(filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);
	playerStore.setLastActioned(filename);

	sendEditRequest(filename, segmentsToSave, video.provider)
		.then(() => {
			if (playerStore.currentVideo?.filename === filename) {
				playerStore.reloadCurrentVideo();
			}
		})
		.catch((err) => {
			if (err instanceof ApiError && err.status === 404) {
				videoListStore.removeVideo(filename);
				playerStore.showList();
				return;
			}
			videoListStore.updateVideoType(filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
		});
}

export function returnToOriginals() {
	const video = playerStore.currentVideo;
	if (!video || video.type !== VIDEO_TYPE.EDITED) return;

	const filename = video.filename;
	videoListStore.updateVideoType(filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
	playerStore.setLastActioned(filename);

	sendReturnRequest(video, video.provider).catch((err) => {
		if (err instanceof ApiError && err.status === 404) {
			videoListStore.removeVideo(filename);
			playerStore.showList();
			return;
		}
		videoListStore.updateVideoType(filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);
	});
}
