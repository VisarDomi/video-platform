import { startViewer, showStartupError } from "./core/start";
import { selectProvider } from "./provider";

async function main(): Promise<void> {
    const provider = selectProvider(location.hostname);
    if (!provider.matchRoute(location.pathname)) return;
    if (provider.nativeLogin && window.opener) return;
    try {
        await startViewer(provider);
    } catch (error) {
        showStartupError(provider, error instanceof Error ? error.message : "Unable to start stream viewer.");
    }
}

void main();
