import logger from "../common/logger.js";
import { DownloadsManager } from "./state/downloadsManager.js";
import { AliasManager } from "./state/aliasManager.js";
import { OrphanStreamFinalizer } from "./coordination/orphanStreamFinalizer.js";
import { DiskSpaceMonitor } from "./coordination/diskSpaceMonitor.js";

// Tango Specific Imports
import { TokenManager } from "./tango/api/tokenManager.js";
import { ApiClient } from "./tango/api/apiClient.js";
import { AliasSyncService } from "./tango/discovery/aliasSyncService.js";
import { StreamDiscoveryService } from "./tango/discovery/streamDiscoveryService.js";

// FC2 Specific Imports
import { TargetManager } from "./fc2/discovery/targetManager.js";
import { Fc2Client } from "./fc2/api/fc2Client.js";
import { Fc2DiscoveryService } from "./fc2/discovery/discoveryService.js";

export class DownloaderService {
    // Tango Services
    private tokenManager: TokenManager;
    private aliasSyncService: AliasSyncService;
    private streamDiscoveryService: StreamDiscoveryService;

    // FC2 Services
    private fc2DiscoveryService: Fc2DiscoveryService;

    // Core Services
    private orphanStreamFinalizer: OrphanStreamFinalizer;

    private constructor(
        tokenManager: TokenManager,
        aliasSyncService: AliasSyncService,
        streamDiscoveryService: StreamDiscoveryService,
        fc2DiscoveryService: Fc2DiscoveryService,
        orphanStreamFinalizer: OrphanStreamFinalizer
    ) {
        this.tokenManager = tokenManager;
        this.aliasSyncService = aliasSyncService;
        this.streamDiscoveryService = streamDiscoveryService;
        this.fc2DiscoveryService = fc2DiscoveryService;
        this.orphanStreamFinalizer = orphanStreamFinalizer;
        logger.info("DownloaderService initialized as a composition root.");
    }

    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const aliasManager = await AliasManager.create();

        // --- Tango Initialization ---
        const tokenManager = await TokenManager.create();
        const apiClient = new ApiClient(tokenManager);
        const aliasSyncService = new AliasSyncService(apiClient, aliasManager);
        const streamDiscoveryService = new StreamDiscoveryService(apiClient, aliasManager, downloadsManager);
        // ----------------------------

        // --- FC2 Initialization ---
        const targetManager = TargetManager.create();
        const fc2Client = new Fc2Client();
        const fc2DiscoveryService = new Fc2DiscoveryService(targetManager, fc2Client, downloadsManager);
        // --------------------------

        const orphanStreamFinalizer = new OrphanStreamFinalizer(downloadsManager);

        return new DownloaderService(
            tokenManager,
            aliasSyncService,
            streamDiscoveryService,
            fc2DiscoveryService,
            orphanStreamFinalizer
        );
    }

    public async start() {
        logger.info("Starting all services...");

        this.orphanStreamFinalizer.start();
        DiskSpaceMonitor.run();

        // Start Tango Services
        this.tokenManager.startTokenWatcher();
        this.aliasSyncService.start();
        void this.streamDiscoveryService.start();

        // Start FC2 Services
        this.fc2DiscoveryService.start();
    }
}