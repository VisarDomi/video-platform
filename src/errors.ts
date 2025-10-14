export class FileNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "FileNotFoundError";
    }
}

export class FfmpegError extends Error {
    public stderr: string;

    constructor(message: string, stderr: string = "") {
        super(message);
        this.name = "FfmpegError";
        this.stderr = stderr;
    }
}

export class MoveError extends Error {
    public stderr: string;

    constructor(message: string, stderr: string = "") {
        super(message);
        this.name = "MoveError";
        this.stderr = stderr;
    }
}

export class SegmentError extends Error {
    public stderr: string;

    constructor(message: string, stderr: string = "") {
        super(message);
        this.name = "SegmentError";
        this.stderr = stderr;
    }
}
