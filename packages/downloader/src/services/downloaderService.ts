import logger from "../common/logger.js";
import { DownloadsManager } from "./state/downloadsManager.js";
import { AliasManager } from "shared";
import * as path from "path";
import * as config from "../common/config.js";
import { OrphanStreamFinalizer } from "./coordination/orphanStreamFinalizer.js";
import { DiskSpaceMonitor } from "./coordination/diskSpaceMonitor.js";

import { TokenManager } from "./tslive/api/tokenManager.js";
import { ApiClient } from "./tslive/api/apiClient.js";
import { AliasSyncService } from "./tslive/discovery/aliasSyncService.js";
import { StreamDiscoveryService } from "./tslive/discovery/streamDiscoveryService.js";

import { createLadderTargetManager } from "./ladder/discovery/targetManager.js";
import { LadderClient } from "./ladder/api/ladderClient.js";
import { LadderDiscoveryService } from "./ladder/discovery/discoveryService.js";

import { createScTargetManager } from "./fmp4/discovery/targetManager.js";
import { ScClient } from "./fmp4/api/scClient.js";
import { ScDiscoveryService } from "./fmp4/discovery/discoveryService.js";

import { createTsLiveTargetManager } from "./tslive/discovery/targetManager.js";

export class DownloaderService {
    private tokenManager: TokenManager;
    private apiClient: ApiClient;
    private aliasSyncService: AliasSyncService;
    private streamDiscoveryService: StreamDiscoveryService;

    private ladderDiscoveryService: LadderDiscoveryService;

    private scDiscoveryService: ScDiscoveryService;

    private orphanStreamFinalizer: OrphanStreamFinalizer;

    private constructor(
        tokenManager: TokenManager,
        apiClient: ApiClient,
        aliasSyncService: AliasSyncService,
        streamDiscoveryService: StreamDiscoveryService,
        ladderDiscoveryService: LadderDiscoveryService,
        scDiscoveryService: ScDiscoveryService,
        orphanStreamFinalizer: OrphanStreamFinalizer
    ) {
        this.tokenManager = tokenManager;
        this.apiClient = apiClient;
        this.aliasSyncService = aliasSyncService;
        this.streamDiscoveryService = streamDiscoveryService;
        this.ladderDiscoveryService = ladderDiscoveryService;
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

        const ladderTargetManager = createLadderTargetManager();
        const ladderClient = new LadderClient();
        const ladderDiscoveryService = new LadderDiscoveryService(ladderTargetManager, ladderClient, downloadsManager);

        const scTargetManager = createScTargetManager();
        const scClient = new ScClient();
        await scClient.init();
        const scDiscoveryService = new ScDiscoveryService(scTargetManager, scClient, downloadsManager);

        const tsliveTargetManager = createTsLiveTargetManager();
        streamDiscoveryService.setTargetManager(tsliveTargetManager);

        const orphanStreamFinalizer = new OrphanStreamFinalizer(downloadsManager);

        return new DownloaderService(
            tokenManager,
            apiClient,
            aliasSyncService,
            streamDiscoveryService,
            ladderDiscoveryService,
            scDiscoveryService,
            orphanStreamFinalizer
        );
    }

    public getTsLiveApiClient(): ApiClient {
        return this.apiClient;
    }

    public async start() {
        logger.info("[General] Starting all services...");

        this.orphanStreamFinalizer.start();
        DiskSpaceMonitor.run();

        this.tokenManager.startTokenWatcher();
        this.aliasSyncService.start();
        void this.streamDiscoveryService.start();

        this.ladderDiscoveryService.start();

        this.scDiscoveryService.start();
    }
}