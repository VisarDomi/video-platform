import type { Video } from '../types.js';
import type { TlStreamer } from './tl-api.js';

// --- IndexedDB: tl-cache / streamers ---

interface CachedStreamer {
	streamerId: string;
	masterListUrl: string;
	liveUrl: string | null;
}

const DB_NAME = 'tl-cache';
const STORE_NAME = 'streamers';
const DB_VERSION = 1;

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
		const tx = db.transaction(STORE_NAME, 'readwrite');
		tx.objectStore(STORE_NAME).put({ streamerId, masterListUrl, liveUrl });
	} catch {
		// graceful fallback
	}
}

export async function removeCached(streamerId: string): Promise<void> {
	try {
		const db = await openDb();
		const tx = db.transaction(STORE_NAME, 'readwrite');
		tx.objectStore(STORE_NAME).delete(streamerId);
	} catch {
		// graceful fallback
	}
}

export async function sweepOrphans(activeStreamerIds: Set<string>): Promise<void> {
	try {
		const db = await openDb();
		const tx = db.transaction(STORE_NAME, 'readwrite');
		const store = tx.objectStore(STORE_NAME);
		const req = store.getAllKeys();
		req.onsuccess = () => {
			for (const key of req.result) {
				if (!activeStreamerIds.has(key as string)) {
					store.delete(key);
				}
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
