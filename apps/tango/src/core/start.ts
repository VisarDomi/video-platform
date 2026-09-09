import { takeOverPage, showStatus } from "./page";
import { Handler, type Provider } from "../provider";
import { AuthenticationRequiredError } from "../provider/types";
import { openHome } from "../routes/home";
import { openStream } from "../routes/stream";

export async function startViewer(provider: Provider, shellReady?: () => void): Promise<void> {
    const route = provider.matchRoute(location.pathname);
    if (!route) return;
    if (provider.nativeLogin && location.pathname.replace(/\/$/, "") === provider.nativeLogin.path) {
        // Only the dedicated native login route may wait with site scripts running.
        await provider.nativeLogin.wait();
        if (location.pathname.replace(/\/$/, "") === provider.nativeLogin.path) location.replace(provider.homeUrl);
        return;
    }
    // No network or asynchronous work before the viewer replaces the page.
    takeOverPage(provider.takeover);
    showStatus("Loading…");
    shellReady?.();
    try {
        await provider.startAuthentication();
        if (route.handler === Handler.Home) await openHome(provider);
        else await openStream(provider, route.streamId);
    } catch (error) {
        if (error instanceof AuthenticationRequiredError && provider.nativeLogin) {
            location.replace(provider.nativeLogin.path);
            return;
        }
        throw error;
    }
}

export function showStartupError(provider: Provider, message: string): void {
    showStatus(message, true, provider.playback === "video"
        ? [{ href: "/account", label: "Open XVideos account / login" }, { href: provider.homeUrl, label: "Uploads" }]
        : []);
}
