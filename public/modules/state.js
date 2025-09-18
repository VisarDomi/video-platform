export const state = {
    videoList: [],      // Array of objects: { filename, type }
    currentVideo: null, // The { filename, type } object of the currently playing video
    segments: [],
    seekInterval: null,
    processingVideos: new Set(), // To track videos being edited/deleted
};

export const STORAGE_KEY_PREFIX = 'video-progress-';