import { LIST_API, PC_SERVER, PROVIDERS, type LocalProvider } from '../constants.js';
import type { Membership } from '../player/DownloadListButton.js';
import { getProvider } from '../providers/index.js';
import type { ListEntry } from '../providers/types.js';
import type { Video } from '../types.js';

const LIST_NAMES: Record<LocalProvider, string> = { tango: 'Tango', fc2: 'FC2', sc: 'SC' };

// The +/- button's streamer: recordings by the streamer in their filename, live videos are
// streamers. Null: the video has none.
export async function videoMembership(video: Video): Promise<Membership | null> {
	const source = getProvider(video.provider);
	if (source.kind === 'local') return membership({ list: source.id, identifier: extractIdentifier(video.filename) }, 'site');
	if (source.live) return membership({ list: source.live.downloadList, identifier: video.filename }, 'pc');
	return null;
}

function membership(entry: ListEntry, via: Via): Membership {
	return {
		async isMember() {
			const result = (await request(entry, via, 'member')) as { member?: unknown } | null;
			if (typeof result?.member !== 'boolean') throw new Error('Download-list membership was not answered');
			return result.member;
		},
		async change(add) {
			const result = (await request(entry, via, add ? 'add' : 'remove')) as { success?: boolean } | null;
			if (result?.success !== true) throw new Error('Download-list update was not confirmed');
		}
	};
}

// Local pages use their own site's list; a live provider's page, the PC's.
type Via = 'site' | 'pc';

async function request({ list, identifier }: ListEntry, via: Via, action: keyof (typeof LIST_API)[LocalProvider]): Promise<unknown> {
	const failed = (status: number, body?: unknown) =>
		new Error((body as { error?: string } | null)?.error ?? `Download-list ${action} failed: ${status}`);
	const url = (via === 'pc' ? PC_SERVER : '') + LIST_API[list][action];
	const response = await (action === 'add' || action === 'remove'
		? fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier }) })
		: fetch(`${url}?identifier=${encodeURIComponent(identifier)}`));
	const body = await response.json().catch(() => null) as unknown;
	if (!response.ok) throw failed(response.status, body);
	return body;
}

export function extractIdentifier(filename: string): string {
	const parts = filename.split(' ');
	return parts.length >= 3 ? parts.slice(2).join(' ') : filename;
}
