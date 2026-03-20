import logger from "../common/logger.js";
import { DownloadsManager } from "./state/downloadsManager.js";
import { AliasManager } from "shared";
import * as path from "path";
import * as config from "../common/config.js";
import { OrphanStreamFinalizer } from "./coordination/orphanStreamFinalizer.js";
import { DiskSpaceMonitor } from "./coordination/diskSpaceMonitor.js";

import { TokenManager } from "./tango/api/tokenManager.js";
import { ApiClient } from "./tango/api/apiClient.js";
import { AliasSyncService } from "./tango/discovery/aliasSyncService.js";
import { StreamDiscoveryService } from "./tango/discovery/streamDiscoveryService.js";

import { createFc2TargetManager } from "./fc2/discovery/targetManager.js";
import { Fc2Client } from "./fc2/api/fc2Client.js";
import { Fc2DiscoveryService } from "./fc2/discovery/discoveryService.js";

import { createScTargetManager } from "./sc/discovery/targetManager.js";
import { ScClient } from "./sc/api/scClient.js";
import { ScDiscoveryService } from "./sc/discovery/discoveryService.js";

import { createTangoTargetManager } from "./tango/discovery/targetManager.js";

export class DownloaderService {
    private tokenManager: TokenManager;
    private apiClient: ApiClient;
    private aliasSyncService: AliasSyncService;
    private streamDiscoveryService: StreamDiscoveryService;

    private fc2DiscoveryService: Fc2DiscoveryService;

    private scDiscoveryService: ScDiscoveryService;

    private orphanStreamFinalizer: OrphanStreamFinalizer;

    private constructor(
        tokenManager: TokenManager,
        apiClient: ApiClient,
        aliasSyncService: AliasSyncService,
        streamDiscoveryService: StreamDiscoveryService,
        fc2DiscoveryService: Fc2DiscoveryService,
        scDiscoveryService: ScDiscoveryService,
        orphanStreamFinalizer: OrphanStreamFinalizer
    ) {
        this.tokenManager = tokenManager;
        this.apiClient = apiClient;
        this.aliasSyncService = aliasSyncService;
        this.streamDiscoveryService = streamDiscoveryService;
        this.fc2DiscoveryService = fc2DiscoveryService;
        this.scDiscoveryService = scDiscoveryService;
        this.orphanStreamFinalizer = orphanStreamFinalizer;
        logger.debug("[General] DownloaderService initialized.");
    }

    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const cfg = config.getConfig();
        const aliasManager = new AliasManager(path.join(cfg.sharedStatePath, "aliases.json"));

        const tokenManager = await TokenManager.create();
        const apiClient = new ApiClient(tokenManager);
        const aliasSyncService = new AliasSyncService(apiClient, aliasManager);
        const streamDiscoveryService = new StreamDiscoveryService(apiClient, aliasManager, downloadsManager);

        const fc2TargetManager = createFc2TargetManager();
        const fc2Client = new Fc2Client();
        const fc2DiscoveryService = new Fc2DiscoveryService(fc2TargetManager, fc2Client, downloadsManager);

        const scTargetManager = createScTargetManager();
        const scClient = new ScClient();
        await scClient.init();
        const scDiscoveryService = new ScDiscoveryService(scTargetManager, scClient, downloadsManager);

        const tangoTargetManager = createTangoTargetManager();
        streamDiscoveryService.setTargetManager(tangoTargetManager);

        const orphanStreamFinalizer = new OrphanStreamFinalizer(downloadsManager);

        return new DownloaderService(
            tokenManager,
            apiClient,
            aliasSyncService,
            streamDiscoveryService,
            fc2DiscoveryService,
            scDiscoveryService,
            orphanStreamFinalizer
        );
    }

    public getTangoApiClient(): ApiClient {
        return this.apiClient;
    }

    public async start() {
        logger.info("[General] Starting all services...");

        this.orphanStreamFinalizer.start();
        DiskSpaceMonitor.run();

        this.tokenManager.startTokenWatcher();
        this.aliasSyncService.start();
        void this.streamDiscoveryService.start();

        this.fc2DiscoveryService.start();

        this.scDiscoveryService.start();
    }
}