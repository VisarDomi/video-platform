import logger from "../../../common/logger.js";
import { IStreamProvider } from "../../core/interfaces.js";

export class Fc2Client implements IStreamProvider {
    constructor() {
        logger.info("Fc2Client initialized.");
    }

    /**
     * Checks if a specific channel is currently live.
     * Note: Implementation pending (WebSocket handshake).
     */
    public async isOnline(channelId: string): Promise<boolean> {
        // TODO: Implement actual metadata fetch/WebSocket handshake
        // For now, we return false so the loop runs but doesn't crash
        logger.debug(`[MOCK] Checking online status for FC2 channel: ${channelId}`);
        return false;
    }

    // --- IStreamProvider Implementation ---

    public async getMasterList(masterListUrl: string): Promise<string | null> {
        throw new Error("Method not implemented.");
    }

    public async getLiveList(liveUrl: string): Promise<{ success: boolean; data: string | null }> {
        throw new Error("Method not implemented.");
    }

    public async getTsSegment(tsUrl: string): Promise<Buffer | null> {
        throw new Error("Method not implemented.");
    }
}