import logger from "../common/logger.js";
import { DownloadsManager } from "./state/downloadsManager.js";
import { AliasRegistry } from "shared";
import * as path from "path";
import * as url from "url";
import { config } from "../common/config.js";
import * as utils from "../common/utils.js";
import { OrphanStreamFinalizer } from "./coordination/orphanStreamFinalizer.js";
import { DiskSpaceMonitor } from "./coordination/diskSpaceMonitor.js";

import { TokenManager } from "./tango/api/tokenManager.js";
import { ApiClient } from "./tango/api/apiClient.js";
import { StreamDiscoveryService } from "./tango/discovery/streamDiscoveryService.js";

import { createFc2TargetManager } from "./fc2/discovery/targetManager.js";
import { Fc2Client } from "./fc2/api/fc2Client.js";
import { Fc2DiscoveryService } from "./fc2/discovery/discoveryService.js";

import { ScTargetManager } from "./sc/discovery/targetManager.js";
import { ScClient } from "./sc/api/scClient.js";
import { ScDiscoveryService } from "./sc/discovery/discoveryService.js";

import { createTangoTargetManager } from "./tango/discovery/targetManager.js";

const ALIAS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export class DownloaderService {
    private tokenManager: TokenManager;
    private apiClient: ApiClient;
    private registry: AliasRegistry;
    private streamDiscoveryService: StreamDiscoveryService;
    private fc2DiscoveryService: Fc2DiscoveryService;
    private scDiscoveryService: ScDiscoveryService;
    private orphanStreamFinalizer: OrphanStreamFinalizer;
    private downloadsManager: DownloadsManager;
    private stopRefresh: (() => void) | null = null;

    private constructor(
        tokenManager: TokenManager,
        apiClient: ApiClient,
        registry: AliasRegistry,
        streamDiscoveryService: StreamDiscoveryService,
        fc2DiscoveryService: Fc2DiscoveryService,
        scDiscoveryService: ScDiscoveryService,
        orphanStreamFinalizer: OrphanStreamFinalizer,
        downloadsManager: DownloadsManager,
    ) {
        this.tokenManager = tokenManager;
        this.apiClient = apiClient;
        this.registry = registry;
        this.streamDiscoveryService = streamDiscoveryService;
        this.fc2DiscoveryService = fc2DiscoveryService;
        this.scDiscoveryService = scDiscoveryService;
        this.orphanStreamFinalizer = orphanStreamFinalizer;
        this.downloadsManager = downloadsManager;
        logger.debug("[General] DownloaderService initialized.");
    }

    public static async create(): Promise<DownloaderService> {
        const downloadsManager = await DownloadsManager.create();
        const registry = new AliasRegistry(path.join(config.sharedStatePath, "aliases.json"));
        await registry.load();

        const tokenManager = new TokenManager();
        const apiClient = new ApiClient(tokenManager);
        const streamDiscoveryService = new StreamDiscoveryService(apiClient, registry, downloadsManager);

        const fc2TargetManager = createFc2TargetManager();
        const fc2Client = new Fc2Client();
        const fc2DiscoveryService = new Fc2DiscoveryService(fc2TargetManager, fc2Client, downloadsManager);

        const scTargetManager = ScTargetManager.create();
        const scClient = new ScClient();
        await scClient.init();
        const scDiscoveryService = new ScDiscoveryService(scTargetManager, scClient, downloadsManager);

        const tangoTargetManager = createTangoTargetManager();
        streamDiscoveryService.setTargetManager(tangoTargetManager);

        const orphanStreamFinalizer = new OrphanStreamFinalizer(downloadsManager);

        return new DownloaderService(
            tokenManager,
            apiClient,
            registry,
            streamDiscoveryService,
            fc2DiscoveryService,
            scDiscoveryService,
            orphanStreamFinalizer,
            downloadsManager,
        );
    }

    public async shutdown(): Promise<void> {
        if (this.stopRefresh) this.stopRefresh();
        await this.downloadsManager.shutdownAll();
    }

    public async start() {
        logger.info("[General] Starting all services...");

        this.orphanStreamFinalizer.start();
        DiskSpaceMonitor.run();

        const __filename = url.fileURLToPath(import.meta.url);
        const projectRoot = utils.findProjectRoot(path.dirname(__filename));
        const tangoTxtPath = path.join(projectRoot, "tango.txt");

        const BATCH_CHUNK_SIZE = 500;
        const fetcher = async (ids: string[]) => {
            const result: Record<string, string> = {};
            for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
                const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE);
                const batch = await this.apiClient.getAliasesInBatch(chunk);
                if (!batch) continue;
                for (const id of chunk) {
                    const alias = batch[id]?.basicProfile?.aliases?.[0]?.alias;
                    if (alias) result[id] = alias;
                }
            }
            return result;
        };

        const getStreamerIds = async () => {
            const resp = await this.apiClient.getAllFollowing();
            if (!resp?.followers) return [];
            return resp.followers.map((f: any) => f.accountId);
        };

        this.stopRefresh = this.registry.startPeriodicRefresh(
            ALIAS_REFRESH_INTERVAL_MS,
            getStreamerIds,
            fetcher,
            tangoTxtPath,
        );

        void this.streamDiscoveryService.start();

        this.fc2DiscoveryService.start();

        this.scDiscoveryService.start();
    }
}