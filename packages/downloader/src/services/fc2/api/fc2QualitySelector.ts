import logger from "../../../common/logger.js";

export interface Fc2Playlist {
    url: string;
    mode: number;
    name?: string;
}

export class Fc2QualitySelector {
    // Ported from FC2LiveDL.py
    private static readonly STREAM_QUALITY: { [key: string]: number } = {
        "150Kbps": 10,
        "400Kbps": 20,
        "1.2Mbps": 30,
        "2Mbps": 40,
        "3Mbps": 50,
        "sound": 90,
    };

    private static readonly STREAM_LATENCY: { [key: string]: number } = {
        "low": 0,
        "high": 1,
        "mid": 2,
    };

    // We default to max settings: 3Mbps + mid latency (latency 2)
    // Mode calculation: Quality + Latency
    // 3Mbps (50) + mid (2) = 52
    private static readonly TARGET_QUALITY = "3Mbps";
    private static readonly TARGET_LATENCY = "mid";

    public static selectBestPlaylist(hlsInformation: any): Fc2Playlist | null {
        const playlists = this.mergePlaylists(hlsInformation);
        const sorted = this.sortPlaylists(playlists);
        const targetMode = this.getMode(this.TARGET_QUALITY, this.TARGET_LATENCY);

        if (sorted.length === 0) return null;

        // Log available options for debugging
        const availableModes = sorted.map(p => {
            const { quality, latency } = this.formatMode(p.mode);
            return `${quality} (${latency}) [mode: ${p.mode}]`;
        });
        logger.debug(`[FC2] Available qualities: ${availableModes.join(", ")}`);

        // 1. Try exact match
        let selected = sorted.find(p => p.mode === targetMode);

        // 2. If no exact match, ignore quality and find best matching latency
        if (!selected) {
            const targetLatVal = this.STREAM_LATENCY[this.TARGET_LATENCY];
            selected = sorted.find(p => p.mode % 10 === targetLatVal);
        }

        // 3. Fallback to the absolute "best" (highest mode) available
        if (!selected) {
            selected = sorted[0];
        }

        const { quality, latency } = this.formatMode(selected.mode);
        logger.debug(`[FC2] Selected quality: ${quality} (${latency})`);

        return selected;
    }

    private static mergePlaylists(hlsInfo: any): Fc2Playlist[] {
        const playlists: Fc2Playlist[] = [];
        const keys = ["playlists", "playlists_high_latency", "playlists_middle_latency"];

        for (const key of keys) {
            if (hlsInfo[key] && Array.isArray(hlsInfo[key])) {
                playlists.push(...hlsInfo[key]);
            }
        }
        return playlists;
    }

    private static sortPlaylists(playlists: Fc2Playlist[]): Fc2Playlist[] {
        return playlists.sort((a, b) => {
            // Normalize sound (90) for sorting if necessary, but higher mode usually means better
            const valA = a.mode >= 90 ? a.mode - 90 : a.mode;
            const valB = b.mode >= 90 ? b.mode - 90 : b.mode;
            return valB - valA; // Descending
        });
    }

    private static getMode(quality: string, latency: string): number {
        return this.STREAM_QUALITY[quality] + this.STREAM_LATENCY[latency];
    }

    private static formatMode(mode: number): { quality: string, latency: string } {
        const findKey = (map: any, val: number) => Object.keys(map).find(k => map[k] === val) || "unknown";
        const latency = findKey(this.STREAM_LATENCY, mode % 10);
        const quality = findKey(this.STREAM_QUALITY, Math.floor(mode / 10) * 10);
        return { quality, latency };
    }
}