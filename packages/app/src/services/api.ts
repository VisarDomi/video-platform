import type { Provider } from '../constants.js';
import type { Video } from '../types.js';
import { localActions } from '../providers/index.js';
export { ApiError } from '../providers/types.js';

export function fetchVideos(provider: Provider, after?: string, signal?: AbortSignal): Promise<Video[]> {
    return localActions(provider).fetchVideos(after, signal);
}
export function saveVideo(video: Video): Promise<void> { return localActions(video.provider).save(video); }
export function editVideo(video: Video, segments: string[]): Promise<void> { return localActions(video.provider).edit(video, segments); }
export function returnVideo(video: Video): Promise<void> { return localActions(video.provider).returnOriginal(video); }
