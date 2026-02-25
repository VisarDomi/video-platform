import type { VIDEO_TYPE } from './constants.js';

export type ValueOf<T> = T[keyof T];

export type VideoType = ValueOf<typeof VIDEO_TYPE>;

export interface Video {
	readonly filename: string;
	readonly type: VideoType;
	readonly duration: number;
	readonly size: number;
	readonly isLive?: boolean;
}
