import { videoListStore } from '../stores/videoList.svelte.js';
import { playerStore } from '../stores/player.svelte.js';
import { filterVideos } from '../utils/filter.js';
import { STORAGE_KEYS, VIDEO_TYPE } from '../constants.js';
import { fetchVideos, sendSaveRequest, sendEditRequest, sendReturnRequest } from './api.js';
import { fetchAndParsePlaylist, calculateSegmentsToKeep } from './hls.js';
import type { Video } from '../types.js';

function getAdjacentVideos(videoToAction: Video) {
	const filteredList = filterVideos(videoListStore.videos, videoListStore.filter);
	const idx = filteredList.findIndex(
		(v) => v.filename === videoToAction.filename && v.type === videoToAction.type
	);
	const nextVideo = idx > -1 && idx < filteredList.length - 1 ? filteredList[idx + 1] : null;
	const prevVideo = idx > 0 ? filteredList[idx - 1] : null;
	return { nextVideo, prevVideo };
}

function navigateToNext(nextVideo: Video | null, prevVideo: Video | null) {
	if (nextVideo) {
		void fetchAndParsePlaylist(nextVideo);
		const saved = localStorage.getItem(`${STORAGE_KEYS.PROGRESS_PREFIX}${nextVideo.filename}`);
		const startTime = saved && parseFloat(saved) > 0 ? Math.round(parseFloat(saved)) : 0;
		playerStore.setEditedVideo(nextVideo, startTime, videoListStore.selectedProvider);
	} else {
		playerStore.showList(prevVideo?.filename || null);
	}
}

async function reloadVideos() {
	const videos = await fetchVideos(videoListStore.selectedProvider);
	videoListStore.setVideos(videos);
}

export function saveCurrentVideo() {
	const video = playerStore.currentVideo;
	if (!video || video.type !== VIDEO_TYPE.ORIGINAL || playerStore.segments.length > 0) return;

	// Stay on video, fire request in background
	playerStore.setLastActioned(video.filename);
	sendSaveRequest(video, videoListStore.selectedProvider).then(() => void reloadVideos());
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

	// Clear segments immediately so the UI reflects the action
	playerStore.clearSegments();
	playerStore.setLastActioned(filename);

	// Fire edit request in background
	sendEditRequest(filename, segmentsToSave, videoListStore.selectedProvider).then(() => {
		// If still watching the same video, reload from start
		if (playerStore.currentVideo?.filename === filename) {
			playerStore.reloadCurrentVideo();
		}
		void reloadVideos();
	});
}

export function returnToOriginals() {
	const video = playerStore.currentVideo;
	if (!video || video.type !== VIDEO_TYPE.EDITED) return;

	const { nextVideo, prevVideo } = getAdjacentVideos(video);
	navigateToNext(nextVideo, prevVideo);

	// Optimistically remove from list
	videoListStore.setVideos(
		videoListStore.videos.filter(
			(v) => v.filename !== video.filename || v.type !== video.type
		)
	);

	sendReturnRequest(video, videoListStore.selectedProvider).then(() => void reloadVideos());
}
