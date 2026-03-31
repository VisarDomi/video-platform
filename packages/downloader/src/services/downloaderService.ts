import logger from "../common/logger.js";
import { DownloadsManager } from "./state/downloadsManager.js";
import { AliasRegistry } from "shared";
import * as path from "path";
import * as url from "url";
import { config } from "../common/config.js";
import * as utils from "../common/utils.js";
import { OrphanStreamFinalizer } from "./coordination/orphanStreamFinalizer.js";
import { DiskSpaceMonitor } from "./coordination/diskSpaceMonitor.js";

import { TokenManager } from "./tslive/api/tokenManager.js";
import { ApiClient } from "./tslive/api/apiClient.js";
import { StreamDiscoveryService } from "./tslive/discovery/streamDiscoveryService.js";

import { createLadderTargetManager } from "./ladder/discovery/targetManager.js";
import { LadderClient } from "./ladder/api/ladderClient.js";
import { LadderDiscoveryService } from "./ladder/discovery/discoveryService.js";

import { ScTargetManager } from "./fmp4/discovery/targetManager.js";
import { ScClient } from "./fmp4/api/scClient.js";
import { ScDiscoveryService } from "./fmp4/discovery/discoveryService.js";

import { createTsLiveTargetManager } from "./tslive/discovery/targetManager.js";

const ALIAS_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export class DownloaderService {
    private tokenManager: TokenManager;
    private apiClient: ApiClient;
    private registry: AliasRegistry;
    private streamDiscoveryService: StreamDiscoveryService;
    private ladderDiscoveryService: LadderDiscoveryService;
    private scDiscoveryService: ScDiscoveryService;
    private orphanStreamFinalizer: OrphanStreamFinalizer;
    private downloadsManager: DownloadsManager;
    private stopRefresh: (() => void) | null = null;

    private constructor(
        tokenManager: TokenManager,
        apiClient: ApiClient,
        registry: AliasRegistry,
        streamDiscoveryService: StreamDiscoveryService,
        ladderDiscoveryService: LadderDiscoveryService,
        scDiscoveryService: ScDiscoveryService,
        orphanStreamFinalizer: OrphanStreamFinalizer,
        downloadsManager: DownloadsManager,
    ) {
        this.tokenManager = tokenManager;
        this.apiClient = apiClient;
        this.registry = registry;
        this.streamDiscoveryService = streamDiscoveryService;
        this.ladderDiscoveryService = ladderDiscoveryService;
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

        const ladderTargetManager = createLadderTargetManager();
        const ladderClient = new LadderClient();
        const ladderDiscoveryService = new LadderDiscoveryService(ladderTargetManager, ladderClient, downloadsManager);

        const scTargetManager = ScTargetManager.create();
        const scClient = new ScClient();
        await scClient.init();
        const scDiscoveryService = new ScDiscoveryService(scTargetManager, scClient, downloadsManager);

        const tsliveTargetManager = createTsLiveTargetManager();
        streamDiscoveryService.setTargetManager(tsliveTargetManager);

        const orphanStreamFinalizer = new OrphanStreamFinalizer(downloadsManager);

        return new DownloaderService(
            tokenManager,
            apiClient,
            registry,
            streamDiscoveryService,
            ladderDiscoveryService,
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
        const tsliveTxtPath = path.join(projectRoot, "tslive.txt");

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
            tsliveTxtPath,
        );

        void this.streamDiscoveryService.start();

        this.ladderDiscoveryService.start();

        this.scDiscoveryService.start();
    }
}