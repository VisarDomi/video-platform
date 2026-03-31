import logger from "../common/logger.js";
import { DownloadsManager } from "./state/downloadsManager.js";
import { AliasRegistry } from "shared";
import * as path from "path";
import { config } from "../common/config.js";
import { DiskSpaceMonitor } from "./coordination/diskSpaceMonitor.js";

import { ApiClient } from "./tslive/api/apiClient.js";
import { StreamDiscoveryService } from "./tslive/discovery/streamDiscoveryService.js";

import { createLadderTargetManager } from "./ladder/discovery/targetManager.js";
import { LadderClient } from "./ladder/api/ladderClient.js";
import { LadderDiscoveryService } from "./ladder/discovery/discoveryService.js";

import { ScTargetManager } from "./fmp4/discovery/targetManager.js";
import { ScClient } from "./fmp4/api/scClient.js";
import { ScDiscoveryService } from "./fmp4/discovery/discoveryService.js";

import { createTsLiveTargetManager } from "./tslive/discovery/targetManager.js";

export class DownloaderService {
    private streamDiscoveryService: StreamDiscoveryService;
    private ladderDiscoveryService: LadderDiscoveryService;
    private scDiscoveryService: ScDiscoveryService;
    private downloadsManager: DownloadsManager;

    private constructor(
        streamDiscoveryService: StreamDiscoveryService,
        ladderDiscoveryService: LadderDiscoveryService,
        scDiscoveryService: ScDiscoveryService,
        downloadsManager: DownloadsManager,
    ) {
        this.streamDiscoveryService = streamDiscoveryService;
        this.ladderDiscoveryService = ladderDiscoveryService;
        this.scDiscoveryService = scDiscoveryService;
        this.downloadsManager = downloadsManager;
        logger.debug("[General] DownloaderService initialized.");
    }

    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const registry = new AliasRegistry(path.join(config.sharedStatePath, "aliases.json"));
        await registry.load();

        const apiClient = new ApiClient();
        const streamDiscoveryService = new StreamDiscoveryService(apiClient, registry, downloadsManager);

        const ladderTargetManager = createLadderTargetManager();
        const ladderClient = new LadderClient();
        const ladderDiscoveryService = new LadderDiscoveryService(ladderTargetManager, ladderClient, downloadsManager);

        const scTargetManager = ScTargetManager.create();
        const scClient = new ScClient();
        await scClient.init();
        const scDiscoveryService = new ScDiscoveryService(scTargetManager, scClient, downloadsManager);

        const tsliveTargetManager = createTsLiveTargetManager();
        streamDiscoveryService.setTargetManager(tsliveTargetManager);

        return new DownloaderService(
            streamDiscoveryService,
            ladderDiscoveryService,
            scDiscoveryService,
            downloadsManager,
        );
    }

    public async shutdown(): Promise<void> {
        await this.downloadsManager.shutdownAll();
    }

    public async start() {
        logger.info("[General] Starting all services...");

        DiskSpaceMonitor.run();

        void this.streamDiscoveryService.start();

        this.ladderDiscoveryService.start();

        this.scDiscoveryService.start();
    }
}
