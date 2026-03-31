import logger from "../common/logger.js";
import { DownloadsManager } from "./state/downloadsManager.js";

import { ApiClient } from "./tango/api/apiClient.js";
import { StreamDiscoveryService } from "./tango/discovery/streamDiscoveryService.js";
import { TangoTargetManager } from "./tango/discovery/targetManager.js";

import { createFc2TargetManager } from "./fc2/discovery/targetManager.js";
import { Fc2Client } from "./fc2/api/fc2Client.js";
import { Fc2DiscoveryService } from "./fc2/discovery/discoveryService.js";

import { ScTargetManager } from "./sc/discovery/targetManager.js";
import { ScClient } from "./sc/api/scClient.js";
import { ScDiscoveryService } from "./sc/discovery/discoveryService.js";

export class DownloaderService {
    private streamDiscoveryService: StreamDiscoveryService;
    private fc2DiscoveryService: Fc2DiscoveryService;
    private scDiscoveryService: ScDiscoveryService;
    private downloadsManager: DownloadsManager;

    private constructor(
        streamDiscoveryService: StreamDiscoveryService,
        fc2DiscoveryService: Fc2DiscoveryService,
        scDiscoveryService: ScDiscoveryService,
        downloadsManager: DownloadsManager,
    ) {
        this.streamDiscoveryService = streamDiscoveryService;
        this.fc2DiscoveryService = fc2DiscoveryService;
        this.scDiscoveryService = scDiscoveryService;
        this.downloadsManager = downloadsManager;
        logger.debug("[General] DownloaderService initialized.");
    }

    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();

        const apiClient = new ApiClient();
        const tangoTargetManager = TangoTargetManager.create();
        const streamDiscoveryService = new StreamDiscoveryService(apiClient, tangoTargetManager, downloadsManager);

        const fc2TargetManager = createFc2TargetManager();
        const fc2Client = new Fc2Client();
        const fc2DiscoveryService = new Fc2DiscoveryService(fc2TargetManager, fc2Client, downloadsManager);

        const scTargetManager = ScTargetManager.create();
        const scClient = new ScClient();
        await scClient.init();
        const scDiscoveryService = new ScDiscoveryService(scTargetManager, scClient, downloadsManager);

        return new DownloaderService(
            streamDiscoveryService,
            fc2DiscoveryService,
            scDiscoveryService,
            downloadsManager,
        );
    }

    public async shutdown(): Promise<void> {
        await this.downloadsManager.shutdownAll();
    }

    public async start() {
        logger.info("[General] Starting all services...");

        void this.streamDiscoveryService.start();

        this.fc2DiscoveryService.start();

        this.scDiscoveryService.start();
    }
}
