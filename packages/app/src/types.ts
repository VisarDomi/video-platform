import type { Provider, VIDEO_TYPE } from './constants.js';

export type VideoType = (typeof VIDEO_TYPE)[keyof typeof VIDEO_TYPE];

export interface Video {
	readonly filename: string;
	readonly title?: string;
	readonly pageUrl?: string;
	readonly type: VideoType;
	readonly duration: number;
	readonly size: number;
	readonly isLive?: boolean;
	// Live providers: whether the streamer is followed, and the stream that revealed a co-streamer.
	readonly following?: boolean;
	readonly parent?: string;
	readonly provider: Provider;
}
