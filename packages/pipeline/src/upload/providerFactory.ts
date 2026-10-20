import type { PipelineConfig } from "../config.js";
import { readProviderCredentials, assertUploadProvider, type ActiveUploadProvider } from "../config/uploadProviders.js";
import { ChromiumVideoHostUploader } from "./chromiumVideoHostUploader.js";

export async function createProviderUploader(config: PipelineConfig, provider: ActiveUploadProvider = "videohost") {
    assertUploadProvider(provider);
    return new ChromiumVideoHostUploader({
        executablePath: config.chromiumExecutablePath,
        profilePath: config.videohostBrowserProfilePath ?? config.browserProfilePath,
        sessionFilePath: config.videohostSessionPath,
        ...readProviderCredentials(config.credentialsFilePath, provider),
    });
}
