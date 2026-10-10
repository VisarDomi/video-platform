import css from '../style.css?inline';
import { AuthenticationRequiredError, type OnlineVideoProvider } from '../providers/types.js';
import { openVideoList } from '../routes/videoList.js';
import { hasNativeViewer } from '../routes/nativeViewer.js';
import { VideoViewerPage } from '../routes/videoViewer.js';

type Boot = { entries: number; startedAt: number; shellAt?: number; readyAt?: number; error?: string };

// One online provider per app: the app injects this script at document start and
// replaces the site's page with the shared viewer.
export function startContentScript(provider: OnlineVideoProvider, hosts: readonly string[]): void {
    if (!hosts.includes(location.hostname)) return;
    const scope = window as typeof window & { __videoPlatformBoot?: Boot };
    const route = provider.matchRoute(location.pathname);
    if (!route || window.opener) return;
    if (scope.__videoPlatformBoot) { scope.__videoPlatformBoot.entries++; return; }
    const boot: Boot = { entries: 1, startedAt: performance.now() };
    Object.defineProperty(scope, '__videoPlatformBoot', { value: boot });
    if (route === 'login') { void provider.waitForLogin(); return; }
    // Keep the existing stop/open/close takeover. The document marker
    // survives parser reentry and starts this runtime only once.
    window.stop();
    document.open();
    document.close();
    if (!document.documentElement) document.appendChild(document.createElement('html'));
    if (!document.head) document.documentElement.appendChild(document.createElement('head'));
    if (!document.body) document.documentElement.appendChild(document.createElement('body'));
    const viewport = document.createElement('meta');
    viewport.name = 'viewport';
    viewport.content = 'width=device-width,initial-scale=1,viewport-fit=cover';
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(viewport, style);
    boot.shellAt = performance.now();
    // Live providers renew their session and playback tokens before anything loads.
    // The app shows a viewer address natively, over the list.
    const viewerPath = route === 'video' && hasNativeViewer() ? location.pathname : null;
    if (viewerPath) history.replaceState(null, '', provider.homeUrl);
    const task = (provider.live?.start() ?? Promise.resolve()).then(() => route === 'list' || viewerPath ? openVideoList(provider.id, viewerPath ? { path: viewerPath } : undefined)
        : new VideoViewerPage(provider.id, location.pathname, null).open());
    void task.then(() => { boot.readyAt = performance.now(); }).catch(error => {
        if (error instanceof AuthenticationRequiredError) { location.replace(provider.loginUrl); return; }
        boot.error = error instanceof Error ? error.message : 'Unable to open the video application.';
        console.error(error);
        const message = document.createElement('p');
        message.className = 'status status-error';
        message.textContent = boot.error;
        document.body.replaceChildren(message);
    });
}
