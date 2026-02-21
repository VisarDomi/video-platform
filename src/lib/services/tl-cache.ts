import type { Video } from '../types.js';
import type { TlStreamer } from './tl-api.js';

// --- IndexedDB: tl-cache / streamers ---
//
// liveUrl is the source of truth for stream liveness (checked via HEAD against
// tango.me). masterListUrl can 404 while liveUrl still serves segments.
//   - putCached: never overwrites a cached liveUrl with null.
//   - removeCached(id, force): force=true bypasses the 24h guard (used when
//     liveUrl confirmed 404 on tango.me). Default keeps the 24h guard for
//     streams that merely disappeared from the API response.
//   - sweepOrphans: same 24h guard for orphaned entries.

interface CachedStreamer {
	streamerId: string;
	masterListUrl: string;
	liveUrl: string | null;
	cachedAt: number;
}

const DB_NAME = 'tl-cache';
const STORE_NAME = 'streamers';
const DB_VERSION = 2;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let dbInstance: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
	if (dbInstance) return Promise.resolve(dbInstance);
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: 'streamerId' });
			}
			// v1→v2: existing entries get cachedAt = now (treat as fresh)
		};
		req.onsuccess = () => {
			dbInstance = req.result;
			resolve(dbInstance);
		};
		req.onerror = () => reject(req.error);
	});
}

export async function getCached(streamerId: string): Promise<CachedStreamer | undefined> {
	try {
		const db = await openDb();
		return new Promise((resolve) => {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const store = tx.objectStore(STORE_NAME);
			const req = store.get(streamerId);
			req.onsuccess = () => resolve(req.result ?? undefined);
			req.onerror = () => resolve(undefined);
		});
	} catch {
		return undefined;
	}
}

export async function putCached(
	streamerId: string,
	masterListUrl: string,
	liveUrl: string | null
): Promise<void> {
	try {
		const db = await openDb();
		// Never overwrite a cached liveUrl with null — masterListUrl can 404
		// while the cached liveUrl still serves segments
		if (!liveUrl) {
			const tx = db.transaction(STORE_NAME, 'readonly');
			const existing = await new Promise<CachedStreamer | undefined>((resolve) => {
				const req = tx.objectStore(STORE_NAME).get(streamerId);
				req.onsuccess = () => resolve(req.result ?? undefined);
				req.onerror = () => resolve(undefined);
			});
			if (existing?.liveUrl) return; // keep existing liveUrl
		}
		const tx = db.transaction(STORE_NAME, 'readwrite');
		tx.objectStore(STORE_NAME).put({ streamerId, masterListUrl, liveUrl, cachedAt: Date.now() });
	} catch {
		// graceful fallback
	}
}

export async function removeCached(streamerId: string, force = false): Promise<void> {
	try {
		const db = await openDb();
		if (!force) {
			// Only delete entries older than 24h — the liveUrl may still serve
			// segments even if the stream disappeared from the API momentarily
			const tx = db.transaction(STORE_NAME, 'readonly');
			const existing = await new Promise<CachedStreamer | undefined>((resolve) => {
				const req = tx.objectStore(STORE_NAME).get(streamerId);
				req.onsuccess = () => resolve(req.result ?? undefined);
				req.onerror = () => resolve(undefined);
			});
			if (!existing) return;
			if (Date.now() - (existing.cachedAt ?? 0) < MAX_AGE_MS) return;
		}
		const deleteTx = db.transaction(STORE_NAME, 'readwrite');
		deleteTx.objectStore(STORE_NAME).delete(streamerId);
	} catch {
		// graceful fallback
	}
}

export async function sweepOrphans(activeStreamerIds: Set<string>): Promise<void> {
	try {
		const db = await openDb();
		const now = Date.now();
		// Only delete orphan entries older than 24h
		const tx = db.transaction(STORE_NAME, 'readwrite');
		const store = tx.objectStore(STORE_NAME);
		const req = store.getAll();
		req.onsuccess = () => {
			for (const entry of req.result as CachedStreamer[]) {
				if (activeStreamerIds.has(entry.streamerId)) continue;
				if (now - (entry.cachedAt ?? 0) < MAX_AGE_MS) continue;
				store.delete(entry.streamerId);
			}
		};
	} catch {
		// graceful fallback
	}
}

// --- In-memory snapshot (survives provider switches within session) ---

interface TlSnapshot {
	videos: Video[];
	streamerMap: Map<string, TlStreamer>;
	processedStreamIds: Set<string>;
	liveFilenameMap: Map<string, string>;
	listIdentifiers: Set<string>;
}

let snapshot: TlSnapshot | null = null;

export function saveTlSnapshot(store: {
	videos: Video[];
	streamerMap: Map<string, TlStreamer>;
	processedStreamIds: Set<string>;
	liveFilenameMap: Map<string, string>;
	listIdentifiers: Set<string>;
}): void {
	snapshot = {
		videos: [...store.videos],
		streamerMap: new Map(store.streamerMap),
		processedStreamIds: new Set(store.processedStreamIds),
		liveFilenameMap: new Map(store.liveFilenameMap),
		listIdentifiers: new Set(store.listIdentifiers)
	};
	console.log('[TL:cache] snapshot saved,', snapshot.videos.length, 'videos');
}

export function restoreTlSnapshot(store: {
	videos: Video[];
	streamerMap: Map<string, TlStreamer>;
	processedStreamIds: Set<string>;
	liveFilenameMap: Map<string, string>;
	listIdentifiers: Set<string>;
	isLoading: boolean;
	setVideos(v: Video[]): void;
	setStreamerMap(m: Map<string, TlStreamer>): void;
	setLiveFilenames(m: Record<string, string>): void;
	setListIdentifiers(ids: string[]): void;
}): boolean {
	if (!snapshot) return false;
	store.setVideos(snapshot.videos);
	store.setStreamerMap(snapshot.streamerMap);
	store.processedStreamIds = new Set(snapshot.processedStreamIds);
	const filenameObj: Record<string, string> = {};
	for (const [k, v] of snapshot.liveFilenameMap) filenameObj[k] = v;
	store.setLiveFilenames(filenameObj);
	store.setListIdentifiers([...snapshot.listIdentifiers]);
	console.log('[TL:cache] snapshot restored,', snapshot.videos.length, 'videos');
	return true;
}

export function clearTlSnapshot(): void {
	snapshot = null;
}
