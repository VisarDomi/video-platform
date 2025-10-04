// public/modules/api.ts
import { Video } from "../types";

/**
 * Fetches the list of all available videos from the server.
 */
export async function fetchVideos(): Promise<Video[]> {
    const response = await fetch(`/api/videos`);
    if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
    }
    return await response.json();
}

/**
 * Fetches a map of video filenames to their durations.
 */
export async function fetchVideoDurations(): Promise<Record<string, number>> {
    const response = await fetch("/api/videos/durations");
    if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
    }
    return await response.json();
}

/**
 * Sends a request to the server to delete a video.
 */
export async function sendDeleteRequest(video: Video): Promise<any> {
    const response = await fetch(`/api/videos/${video.type}/${encodeURIComponent(video.filename)}`, {
        method: "DELETE",
    });
    return await response.json();
}

/**
 * Sends a request to the server to edit a video with the given segments.
 */
export async function sendEditRequest(video: Video, segments: number[]): Promise<any> {
    const segmentPairs = [];
    for (let i = 0; i < segments.length; i += 2) {
        segmentPairs.push({ start: segments[i], end: segments[i + 1] });
    }

    const response = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: video.filename, segments: segmentPairs }),
    });
    return await response.json();
}

/**
 * Sends a request to the server to save a video (move to 'edited' folder).
 */
export async function sendSaveRequest(video: Video): Promise<any> {
    const response = await fetch(`/api/videos/original/${encodeURIComponent(video.filename)}/save`, {
        method: "POST",
    });
    return await response.json();
}
