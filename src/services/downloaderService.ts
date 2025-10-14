// src/downloader/downloaderService.ts
import logger from "../common/logger.js";
import { ApiClient } from "./apiClient.js";
import { DownloadsManager } from "./downloadsManager.js";
import { AliasManager } from "./aliasManager.js";
import { TokenManager } from "./tokenManager.js";
import { AliasSyncService } from "./aliasSyncService.js";
import { StreamDiscoveryService } from "./streamDiscoveryService.js";

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
        // Instantiate managers
        const downloadsManager = await DownloadsManager.create();
        const aliasManager = await AliasManager.create();
        const tokenManager = await TokenManager.create();

        // Instantiate clients and services with their dependencies
        const apiClient = new ApiClient(tokenManager);
        const aliasSyncService = new AliasSyncService(apiClient, aliasManager);
        const streamDiscoveryService = new StreamDiscoveryService(apiClient, aliasManager, downloadsManager);

        return new DownloaderService(tokenManager, aliasSyncService, streamDiscoveryService);
    }

    public async start() {
        logger.info("Starting all services...");

        this.tokenManager.startTokenWatcher();
        this.aliasSyncService.start();
        this.streamDiscoveryService.start();
    }
}
