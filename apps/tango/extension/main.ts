import { startCookiePersistence, type CookieApi } from './cookies';
import { startViewer, showStartupError } from '../src/core/start';
import { selectProvider } from '../src/provider';

type Boot = { entries: number; startedAt: number; shellAt?: number; readyAt?: number; error?: string };
if (typeof window === 'undefined' || ['safari-web-extension:', 'chrome-extension:', 'moz-extension:'].includes(location.protocol)) {
    const scope = globalThis as typeof globalThis & { browser?: CookieApi; chrome: CookieApi };
    startCookiePersistence(scope.browser ?? scope.chrome);
} else {
    const scope = window as typeof window & { __streamViewerExtensionBoot?: Boot };

    // Validate the target before takeover, authentication, or any storage access.
    if (['tango.me', 'www.tango.me', 'xvideos.com', 'www.xvideos.com'].includes(location.hostname)) {
        const provider = selectProvider(location.hostname);
        const route = provider.matchRoute(location.pathname);
        if (!route || (provider.nativeLogin && window.opener)) {
            // Upload management and OAuth popups stay native.
        } else if (scope.__streamViewerExtensionBoot) {
            scope.__streamViewerExtensionBoot.entries++;
        } else {
            const boot: Boot = { entries: 1, startedAt: performance.now() };
            Object.defineProperty(scope, '__streamViewerExtensionBoot', { value: boot });
            void startViewer(provider, () => { boot.shellAt = performance.now(); }).then(() => {
                boot.readyAt = performance.now();
            }).catch(error => {
                boot.error = error instanceof Error ? error.message : 'Unable to start stream viewer.';
                showStartupError(provider, boot.error);
            });
        }
    }

}
