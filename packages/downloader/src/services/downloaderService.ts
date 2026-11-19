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

    // The start-up order is the one monitoring knows: live-status.json is cleared first,
    // then every site's list is read ("Loaded N targets", in sites-file order), then each
    // site's own start-up work (e.g. loading key files) runs.
    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const sites = await loadCaptureSites();
        const targetManagers = sites.map((site) =>
            TargetManager.create({ filePath: site.downloadList, catalog: site.catalog, log: site.log }));
        for (const site of sites) await site.init();
        const loops = sites.map((site, index) =>
            new DiscoveryLoop(site, site.capture, targetManagers[index], downloadsManager));
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
