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
import { createFc2TargetManager } from "./fc2/discovery/targetManager.js";
import { Fc2Client } from "./fc2/api/fc2Client.js";
import { Fc2DiscoveryService } from "./fc2/discovery/discoveryService.js";

// SC Specific Imports
import { createScTargetManager } from "./sc/discovery/targetManager.js";
import { ScClient } from "./sc/api/scClient.js";
import { ScDiscoveryService } from "./sc/discovery/discoveryService.js";

// Tango Target Manager
import { createTangoTargetManager } from "./tango/discovery/targetManager.js";

export class DownloaderService {
    // Tango Services
    private tokenManager: TokenManager;
    private apiClient: ApiClient;
    private aliasSyncService: AliasSyncService;
    private streamDiscoveryService: StreamDiscoveryService;

    // FC2 Services
    private fc2DiscoveryService: Fc2DiscoveryService;

    // SC Services
    private scDiscoveryService: ScDiscoveryService;

    // Core Services
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
        logger.info("[General] DownloaderService initialized as a composition root.");
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
        const fc2TargetManager = createFc2TargetManager();
        const fc2Client = new Fc2Client();
        const fc2DiscoveryService = new Fc2DiscoveryService(fc2TargetManager, fc2Client, downloadsManager);
        // --------------------------

        // --- SC Initialization ---
        const scTargetManager = createScTargetManager();
        const scClient = new ScClient();
        const scDiscoveryService = new ScDiscoveryService(scTargetManager, scClient, downloadsManager);
        // -------------------------

        // --- Tango Target Manager (for tango.txt filtering) ---
        const tangoTargetManager = createTangoTargetManager();
        streamDiscoveryService.setTargetManager(tangoTargetManager);
        // ------------------------------------------------------

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

        // Start Tango Services
        this.tokenManager.startTokenWatcher();
        this.aliasSyncService.start();
        void this.streamDiscoveryService.start();

        // Start FC2 Services
        this.fc2DiscoveryService.start();

        // Start SC Services
        this.scDiscoveryService.start();
    }
}