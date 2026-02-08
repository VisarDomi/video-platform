import { videoListStore } from '../stores/videoList.svelte.js';
import { playerStore } from '../stores/player.svelte.js';
import { VIDEO_TYPE } from '../constants.js';
import { fetchVideos, sendSaveRequest, sendEditRequest, sendReturnRequest } from './api.js';
import { fetchAndParsePlaylist, calculateSegmentsToKeep } from './hls.js';

async function reloadVideos() {
	const videos = await fetchVideos(videoListStore.selectedProvider);
	videoListStore.setVideos(videos);
}

export function saveCurrentVideo() {
	const video = playerStore.currentVideo;
	if (!video || video.type !== VIDEO_TYPE.ORIGINAL || playerStore.segments.length > 0) return;

	const provider = videoListStore.selectedProvider;

	// Update UI immediately: original → edited (player + list + localStorage)
	playerStore.markCurrentAsEdited(provider);
	playerStore.setLastActioned(video.filename);
	videoListStore.updateVideoType(video.filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);
	sendSaveRequest(video, provider).catch(() => {
		if (playerStore.currentVideo?.filename === video.filename) {
			playerStore.markCurrentAsOriginal(provider);
		}
		videoListStore.updateVideoType(video.filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
		void reloadVideos();
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

	// Update UI immediately: clear segments, mark as edited (player + list + localStorage)
	playerStore.clearSegments();
	playerStore.markCurrentAsEdited(provider);
	playerStore.setLastActioned(filename);
	videoListStore.updateVideoType(filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);

	// Fire edit request in background
	sendEditRequest(filename, segmentsToSave, provider)
		.then(() => {
			// If still watching the same video, reload from start
			if (playerStore.currentVideo?.filename === filename) {
				playerStore.reloadCurrentVideo();
			}
		})
		.catch(() => {
			if (playerStore.currentVideo?.filename === filename) {
				playerStore.markCurrentAsOriginal(provider);
			}
			videoListStore.updateVideoType(filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
			void reloadVideos();
		});
}

export function returnToOriginals() {
	const video = playerStore.currentVideo;
	if (!video || video.type !== VIDEO_TYPE.EDITED) return;

	const provider = videoListStore.selectedProvider;

	// Update UI immediately: edited → original (player + list + localStorage)
	playerStore.markCurrentAsOriginal(provider);
	playerStore.setLastActioned(video.filename);
	videoListStore.updateVideoType(video.filename, VIDEO_TYPE.EDITED, VIDEO_TYPE.ORIGINAL);
	sendReturnRequest(video, provider).catch(() => {
		if (playerStore.currentVideo?.filename === video.filename) {
			playerStore.markCurrentAsEdited(provider);
		}
		videoListStore.updateVideoType(video.filename, VIDEO_TYPE.ORIGINAL, VIDEO_TYPE.EDITED);
		void reloadVideos();
	});
}
