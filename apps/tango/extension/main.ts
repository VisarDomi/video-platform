import { takeOverPage, showStatus } from '../src/core/page';
import { Handler, selectProvider } from '../src/provider';
import { openHome } from '../src/routes/home';
import { openStream } from '../src/routes/stream';

type Boot = { entries: number; startedAt: number; shellAt?: number; readyAt?: number; error?: string };
const scope = window as typeof window & { __streamViewerExtensionBoot?: Boot };

// Validate the target before takeover, authentication, or any storage access.
if (location.hostname === 'tango.me' || location.hostname === 'www.tango.me') {
    const provider = selectProvider(location.hostname);
    const route = provider.matchRoute(location.pathname);
    if (scope.__streamViewerExtensionBoot) {
        scope.__streamViewerExtensionBoot.entries++;
    } else {
        const boot: Boot = { entries: 1, startedAt: performance.now() };
        Object.defineProperty(scope, '__streamViewerExtensionBoot', { value: boot });
        takeOverPage();
        showStatus('Loading…');
        boot.shellAt = performance.now();
        void (async () => {
            try {
                await provider.startAuthentication();
                if (route.handler === Handler.Home) await openHome(provider);
                else await openStream(provider, route.streamId);
                boot.readyAt = performance.now();
            } catch (error) {
                boot.error = error instanceof Error ? error.message : 'Unable to start stream viewer.';
                showStatus(boot.error, true);
            }
        })();
    }
}
