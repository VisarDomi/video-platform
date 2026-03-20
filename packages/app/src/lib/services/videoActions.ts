import { videoListStore } from '../stores/videoList.svelte.js';
import { playerStore } from '../stores/player.svelte.js';
import { VIDEO_TYPE } from '../constants.js';
import { sendSaveRequest, sendEditRequest, sendReturnRequest, ApiError } from './api.js';
import { fetchAndParsePlaylist, calculateSegmentsToKeep } from './hls.js';

export function saveCurrentVideo() {
	const video = playerStore.currentVideo;
	if (!video || video.type !== VIDEO_TYPE.ORIGINAL || playerStore.segments.length > 0) return;

	const provider = videoListStore.selectedProvider;

	playerStore.markCurrentAsEdited(provider);
	playerStore.setLastActioned(video.filename);
	videoListStore.updateVideoType(video.filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);
	sendSaveRequest(video, provider).catch((err) => {
		if (err instanceof ApiError && err.status === 404) {
			videoListStore.removeVideo(video.filename);
			playerStore.showList();
			return;
		}
		if (playerStore.currentVideo?.filename === video.filename) {
			playerStore.markCurrentAsOriginal(provider);
		}
		videoListStore.updateVideoType(video.filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
	});
}

export async function createEditedVideo() {
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
	if (!playlistData) return;

	const segmentsToSave = calculateSegmentsToKeep(playlistData.segments, timeSegments);
	const filename = video.filename;

	const provider = videoListStore.selectedProvider;

	playerStore.clearSegments();
	playerStore.markCurrentAsEdited(provider);
	playerStore.setLastActioned(filename);
	videoListStore.updateVideoType(filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);

	sendEditRequest(filename, segmentsToSave, provider)
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
			if (playerStore.currentVideo?.filename === filename) {
				playerStore.markCurrentAsOriginal(provider);
			}
			videoListStore.updateVideoType(filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
		});
}

export function returnToOriginals() {
	const video = playerStore.currentVideo;
	if (!video || video.type !== VIDEO_TYPE.EDITED) return;

	const provider = videoListStore.selectedProvider;

	playerStore.markCurrentAsOriginal(provider);
	playerStore.setLastActioned(video.filename);
	videoListStore.updateVideoType(video.filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
	sendReturnRequest(video, provider).catch((err) => {
		if (err instanceof ApiError && err.status === 404) {
			videoListStore.removeVideo(video.filename);
			playerStore.showList();
			return;
		}
		if (playerStore.currentVideo?.filename === video.filename) {
			playerStore.markCurrentAsEdited(provider);
		}
		videoListStore.updateVideoType(video.filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);
	});
}
