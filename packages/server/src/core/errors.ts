import { ERROR_NAMES, MISC } from "./constants.js";

export class FileNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = ERROR_NAMES.FILE_NOT_FOUND;
    }
}

export class MoveError extends Error {
    public stderr: string;

    constructor(message: string, stderr: string = MISC.EMPTY_STRING) {
        super(message);
        this.name = ERROR_NAMES.MOVE;
        this.stderr = stderr;
    }
}

export class SegmentError extends Error {
    public stderr: string;

    constructor(message: string, stderr: string = MISC.EMPTY_STRING) {
        super(message);
        this.name = ERROR_NAMES.SEGMENT;
        this.stderr = stderr;
    }
}
