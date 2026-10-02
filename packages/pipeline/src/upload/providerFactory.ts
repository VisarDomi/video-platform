import type { PipelineConfig } from "../config.js";
import { activeUploadProvider } from "../config.js";
import { readProviderCredentials, type ActiveUploadProvider } from "../config/uploadProviders.js";
import { readOldHostCredentials } from "../config/secrets.js";
import { ChromiumOldHostUploader } from "./chromiumOldHostUploader.js";
import { ChromiumVideoHostUploader } from "./chromiumVideoHostUploader.js";

export async function createProviderUploader(config: PipelineConfig, provider: ActiveUploadProvider = activeUploadProvider(config)) {
    const credentials = provider === "oldhost" ? await readOldHostCredentials(config.credentialsFilePath)
        : readProviderCredentials(config.credentialsFilePath, provider);
    const browser = {
        executablePath: config.chromiumExecutablePath,
        profilePath: provider === "videohost" ? config.videohostBrowserProfilePath ?? config.browserProfilePath : config.browserProfilePath,
        leaveOpenOnFailure: process.env.VIDEO_PIPELINE_SERVICE_MODE !== "1",
        sessionFilePath: provider === "videohost" ? config.videohostSessionPath : undefined,
        ...credentials,
    };
    return provider === "oldhost" ? new ChromiumOldHostUploader(browser) : new ChromiumVideoHostUploader(browser);
}
