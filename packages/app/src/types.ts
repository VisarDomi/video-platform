import type { Provider, VIDEO_TYPE } from './constants.js';

export type VideoType = (typeof VIDEO_TYPE)[keyof typeof VIDEO_TYPE];

export interface Video {
	readonly filename: string;
	readonly type: VideoType;
	readonly duration: number;
	readonly size: number;
	readonly isLive?: boolean;
	readonly provider: Provider;
}
