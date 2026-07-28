import { takeOverPage, showStatus } from "./core/page";
import { Handler, selectProvider } from "./provider";
import { openHome } from "./routes/home";
import { openStream } from "./routes/stream";

async function main(): Promise<void> {
    const provider = selectProvider(location.hostname);
    const route = provider.matchRoute(location.pathname);
    takeOverPage();
    showStatus("Loading…");

    try {
        await provider.startAuthentication();
        if (route.handler === Handler.Home) await openHome(provider);
        else await openStream(provider, route.streamId);
    } catch (error) {
        showStatus(error instanceof Error ? error.message : "Unable to start stream viewer.", true);
    }
}

void main();
