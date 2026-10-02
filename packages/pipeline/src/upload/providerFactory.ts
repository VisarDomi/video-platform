import type { PipelineConfig } from "../config.js";
import { activeUploadProvider } from "../config.js";
import { readProviderCredentials, type ActiveUploadProvider } from "../config/uploadProviders.js";
import { readXvideosCredentials } from "../config/secrets.js";
import { ChromiumXvideosUploader } from "./chromiumXvideosUploader.js";
import { ChromiumPorntrexUploader } from "./chromiumPorntrexUploader.js";

export async function createProviderUploader(config: PipelineConfig, provider: ActiveUploadProvider = activeUploadProvider(config)) {
    const credentials = provider === "xvideos" ? await readXvideosCredentials(config.credentialsFilePath)
        : readProviderCredentials(config.credentialsFilePath, provider);
    const browser = {
        executablePath: config.chromiumExecutablePath,
        profilePath: provider === "porntrex" ? config.porntrexBrowserProfilePath ?? config.browserProfilePath : config.browserProfilePath,
        leaveOpenOnFailure: process.env.VIDEO_PIPELINE_SERVICE_MODE !== "1",
        ...credentials,
    };
    return provider === "xvideos" ? new ChromiumXvideosUploader(browser) : new ChromiumPorntrexUploader(browser);
}
