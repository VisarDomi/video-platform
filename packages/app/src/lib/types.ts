import type { VIDEO_TYPE } from './constants.js';

export type ValueOf<T> = T[keyof T];

export type VideoType = ValueOf<typeof VIDEO_TYPE>;

export interface Video {
	readonly filename: string;
	readonly type: VideoType;
	readonly duration: number;
	readonly size: number;
	readonly isLive?: boolean;
	readonly provider: string;
}

export interface VideoKey {
	readonly filename: string;
	readonly type: VideoType;
}

export function videoKeyEquals(a: VideoKey | null, b: VideoKey | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.filename === b.filename && a.type === b.type;
}

export function videoToKey(v: Video): VideoKey {
	return { filename: v.filename, type: v.type };
}
