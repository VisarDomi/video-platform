export const state = {
    videoList: [],      // Array of objects: { filename, type }
    currentVideo: null, // The { filename, type } object of the currently playing video
    lastPlayedVideo: null, // To remember for highlighting when returning to the list
    segments: [],
};

export const STORAGE_KEY_PREFIX = 'video-progress-';