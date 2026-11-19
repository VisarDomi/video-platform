import logger from "../common/logger.js";
import { DownloadsManager } from "./state/downloadsManager.js";
import { DiscoveryLoop } from "./common/discoveryLoop.js";
import { TargetManager } from "./common/targetManager.js";
import { loadCaptureSites } from "./sites.js";

export class DownloaderService {
    private constructor(
        private readonly loops: DiscoveryLoop[],
        private readonly downloadsManager: DownloadsManager,
    ) {
        logger.debug("[General] DownloaderService initialized.");
    }

    // Loads the sites named in the sites file and reads each one's download list.
    public static async create(): Promise<DownloaderService> {
        const sites = await loadCaptureSites();
        const downloadsManager = await DownloadsManager.create();
        const loops = sites.map((site) => new DiscoveryLoop(
            site,
            site.capture,
            TargetManager.create({ filePath: site.downloadList, catalog: site.catalog, log: site.log }),
            downloadsManager,
        ));
        return new DownloaderService(loops, downloadsManager);
    }

    public async shutdown(): Promise<void> {
        await this.downloadsManager.shutdownAll();
    }

    public async start() {
        logger.info("[General] Starting all services...");
        for (const loop of this.loops) void loop.start();
    }
}
