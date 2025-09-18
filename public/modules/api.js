/**
 * Fetches the list of all available videos from the server.
 */
export async function fetchVideos() {
    const response = await fetch(`/api/videos`);
    if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`);
    }
    return await response.json();
}

/**
 * Sends a request to the server to delete a video.
 */
export async function sendDeleteRequest(video) {
    const response = await fetch(`/api/videos/${video.type}/${encodeURIComponent(video.filename)}`, {
        method: 'DELETE',
    });
    return await response.json();
}

/**
 * Sends a request to the server to edit a video with the given segments.
 */
export async function sendEditRequest(video, segments) {
    const segmentPairs = [];
    for (let i = 0; i < segments.length; i += 2) {
        segmentPairs.push({ start: segments[i], end: segments[i + 1] });
    }
    
    const response = await fetch('/api/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: video.filename, segments: segmentPairs }) 
    });
    return await response.json();
}