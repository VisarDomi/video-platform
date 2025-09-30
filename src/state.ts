// src/state.ts

// --- Auth State ---
let _tt: string;
let _ttu: string;
let _tte: string;
let _tangoST: string;

// --- Download State ---
export interface ActiveDownload {
    streamerId: string;
    alias: string;
    liveUrl: string | null; // Is null until the master playlist is resolved
}
// The key is the master playlist URL from the /following API response
const _activeDownloads: Map<string, ActiveDownload> = new Map();


// --- Auth Getters and Setters ---
export function setTt(tt: string): void { _tt = tt; }
export function setTtu(ttu: string): void { _ttu = ttu; }
export function setTte(tte: string): void { _tte = tte; }
export function setTangoST(tangoST: string): void { _tangoST = tangoST; }
export function getTt(): string { return _tt; }
export function getTtu(): string { return _ttu; }
export function getTte(): string { return _tte; }
export function getTangoST(): string { return _tangoST; }

// --- Download Getters ---
// The Map is mutated directly, so we just need a getter.
export function getActiveDownloads(): Map<string, ActiveDownload> { return _activeDownloads; }