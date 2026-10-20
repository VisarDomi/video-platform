import type { PipelineConfig } from "../config.js";
import { readProviderCredentials, assertUploadProvider, type ActiveUploadProvider } from "../config/uploadProviders.js";
import { ChromiumPorntrexUploader } from "./chromiumPorntrexUploader.js";

export async function createProviderUploader(config: PipelineConfig, provider: ActiveUploadProvider = "porntrex") {
    assertUploadProvider(provider);
    return new ChromiumPorntrexUploader({
        executablePath: config.chromiumExecutablePath,
        profilePath: config.porntrexBrowserProfilePath ?? config.browserProfilePath,
        sessionFilePath: config.porntrexSessionPath,
        ...readProviderCredentials(config.credentialsFilePath, provider),
    });
}
