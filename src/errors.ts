// src/errors.ts

/**
 * Custom error to be thrown when a file cannot be found in the configured directories.
 */
export class FileNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FileNotFoundError';
    }
}

/**
 * Custom error for when the ffmpeg process fails.
 */
export class FfmpegError extends Error {
    public stderr: string;

    constructor(message: string, stderr: string = '') {
        super(message);
        this.name = 'FfmpegError';
        this.stderr = stderr;
    }
}