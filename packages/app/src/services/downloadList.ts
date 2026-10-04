import { LIST_API, PC_SERVER, PROVIDERS, type LocalProvider } from '../constants.js';
import type { Membership } from '../player/DownloadListButton.js';
import { getProvider } from '../providers/index.js';
import type { ListEntry } from '../providers/types.js';
import type { Video } from '../types.js';

const LIST_NAMES: Record<LocalProvider, string> = { tango: 'Tango', fc2: 'FC2', sc: 'SC' };

// The +/- button's streamer: recordings by the streamer in their filename, live videos are
// streamers, uploads by their recording (only inside the app). Null: the video has none.
export async function videoMembership(video: Video): Promise<Membership | null> {
	const source = getProvider(video.provider);
	if (source.kind === 'local') return membership({ list: source.id, identifier: extractIdentifier(video.filename) }, 'site');
	if (source.live) return membership({ list: source.live.downloadList, identifier: video.filename }, 'pc');
	const identifier = source.uploadStreamer?.(video);
	return identifier && window.webkit?.messageHandlers?.downloadList ? uploadMembership(identifier) : null;
}

// Video Vault's uploads can be any provider's recording: the streamer is listed if any list has
// them. Adding asks the three providers at once who has a streamer by this name: one adds at
// once, several are offered to pick from (the video playing shows whose it is), none is 🔍.
function uploadMembership(identifier: string): Membership {
	const lists = PROVIDERS.map(list => ({ list, membership: membership({ list, identifier }, 'app') }));
	let listedIn: LocalProvider[] = [];
	return {
		async isMember() {
			const answers = await Promise.all(lists.map(({ membership }) => membership.isMember()));
			listedIn = PROVIDERS.filter((_, index) => answers[index]);
			return listedIn.length > 0;
		},
		async targets(add) {
			if (!add) return listedIn.map(list => LIST_NAMES[list]);
			const found = await Promise.all(PROVIDERS.map(list => exists({ list, identifier })));
			return PROVIDERS.filter((_, index) => found[index]).map(list => LIST_NAMES[list]);
		},
		async change(add, target) {
			const chosen = lists.find(({ list }) => LIST_NAMES[list] === target);
			if (!chosen) throw new Error('Choose a download list.');
			await chosen.membership.change(add);
		}
	};
}

// Whether the list's provider has a streamer by this name; a failed lookup throws (⚠️).
async function exists(entry: ListEntry): Promise<boolean> {
	const result = (await request(entry, 'app', 'exists')) as { exists?: unknown } | null;
	if (typeof result?.exists !== 'boolean') throw new Error('The provider lookup was not answered');
	return result.exists;
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

// Local pages use their own site's list, Tango's page (tango.me) the PC's. Video Vault asks
// its app, as the live extensions ask their background page, so no site's security policy applies.
type Via = 'site' | 'pc' | 'app';

async function request({ list, identifier }: ListEntry, via: Via, action: keyof (typeof LIST_API)[LocalProvider]): Promise<unknown> {
	const failed = (status: number, body?: unknown) =>
		new Error((body as { error?: string } | null)?.error ?? `Download-list ${action} failed: ${status}`);
	if (via === 'app') {
		const bridge = window.webkit?.messageHandlers?.downloadList;
		if (!bridge) throw new Error('The app has no download list.');
		const reply = (await bridge.postMessage({ list, action, identifier })) as { status: number; body: string };
		let body: unknown = null;
		try { body = JSON.parse(reply.body); } catch { /* Not JSON: no answer. */ }
		if (reply.status < 200 || reply.status > 299) throw failed(reply.status, body);
		return body;
	}
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
