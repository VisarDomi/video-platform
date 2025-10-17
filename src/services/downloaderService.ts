import logger from "../common/logger.js";
import { ApiClient } from "./api/apiClient.js";
import { DownloadsManager } from "./state/downloadsManager.js";
import { AliasManager } from "./state/aliasManager.js";
import { TokenManager } from "./api/tokenManager.js";
import { AliasSyncService } from "./coordination/aliasSyncService.js";
import { StreamDiscoveryService } from "./coordination/streamDiscoveryService.js";
import { OrphanStreamFinalizer } from "./coordination/orphanStreamFinalizer.js";

export class DownloaderService {
    private tokenManager: TokenManager;
    private aliasSyncService: AliasSyncService;
    private streamDiscoveryService: StreamDiscoveryService;

    private constructor(tokenManager: TokenManager, aliasSyncService: AliasSyncService, streamDiscoveryService: StreamDiscoveryService) {
        this.tokenManager = tokenManager;
        this.aliasSyncService = aliasSyncService;
        this.streamDiscoveryService = streamDiscoveryService;
        logger.info("DownloaderService initialized as a composition root.");
    }

    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const aliasManager = await AliasManager.create();
        const tokenManager = await TokenManager.create();

        const apiClient = new ApiClient(tokenManager);
        const aliasSyncService = new AliasSyncService(apiClient, aliasManager);
        const streamDiscoveryService = new StreamDiscoveryService(apiClient, aliasManager, downloadsManager);

        return new DownloaderService(tokenManager, aliasSyncService, streamDiscoveryService);
    }

    public async start() {
        logger.info("Starting all services...");

        OrphanStreamFinalizer.run();

        this.tokenManager.startTokenWatcher();
        this.aliasSyncService.start();
        this.streamDiscoveryService.start();
    }
}
