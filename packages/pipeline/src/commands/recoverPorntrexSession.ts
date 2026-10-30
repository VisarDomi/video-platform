import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PipelineConfig } from '../config.js';
import { PtrexPhone } from '../phone/ptrexPhone.js';
import { createProviderUploader } from '../upload/providerFactory.js';
import { checkPorntrexSession } from '../upload/porntrexKeepalive.js';
import { pinCookies, readPorntrexSession, sessionFingerprint, writePorntrexSession } from '../upload/porntrexSession.js';
import { connectPorntrexPhone, type ConnectDependencies } from './connectPorntrexPhone.js';

interface Dependencies {
    phone: Pick<PtrexPhone, 'readSession' | 'connect'>;
    check: typeof checkPorntrexSession;
    openBrowser: () => Promise<void>;
}
const defaults = (config: PipelineConfig): Dependencies => ({ phone: new PtrexPhone(), check: checkPorntrexSession,
    openBrowser: async () => { const uploader = await createProviderUploader(config);
        await uploader.withAuthenticatedPage(async () => {}, { allowPasswordLogin: true }); } });

// Called under the recovery lock. Before a password login, inspect and validate
// the phone's retained cookie. An unreachable phone defers recovery rather than
// risking invalidating a still-working phone login. Successful PC authentication
// survives a failed phone transfer; the next run only retries that transfer.
export async function recoverPorntrexSession(config: PipelineConfig, allowPasswordLogin: boolean, deps = defaults(config)): Promise<void> {
    const { phone, check } = deps, file = config.porntrexSessionPath;
    if (!file) throw new Error('No shared session configured');
    const dependencies: ConnectDependencies = {
        openPipelineSession: async allow => {
            if ((await check(file)).loggedIn) return;
            if (!allow) throw new Error('The shared session changed while synchronizing; retry with fresh evidence');
            const retained = await phone.readSession(); // Must succeed before any password request.
            const stored = await readPorntrexSession(file);
            if (!stored) throw new Error('The shared session disappeared during recovery');
            const alternatives = retained.filter(cookie => cookie.name === 'PHPSESSID'
                && sessionFingerprint([cookie]) !== sessionFingerprint(stored.cookies));
            for (const alternative of alternatives) {
                const directory = await fs.mkdtemp(path.join(path.dirname(file), '.phone-session-'));
                try {
                    const candidate = path.join(directory, 'session.json');
                    await writePorntrexSession(candidate, { ...stored, cookies: pinCookies([alternative,
                        ...retained.filter(cookie => cookie.name === 'confirmed')]), savedAt: new Date().toISOString() });
                    if ((await check(candidate)).loggedIn) {
                        const validated = await readPorntrexSession(candidate);
                        if (!validated) throw new Error('Validated phone session disappeared');
                        await writePorntrexSession(file, validated);
                        return;
                    }
                } finally { await fs.rm(directory, { recursive: true, force: true }); }
            }
            await deps.openBrowser();
        },
        connectPhone: cookies => phone.connect(cookies),
        checkSession: check,
        pause: ms => new Promise(resolve => setTimeout(resolve, ms)),
        log: message => console.error(message),
    };
    await connectPorntrexPhone(config, dependencies, { allowPasswordLogin, preserveCampaign: true,
        lockHeld: true, maxIdleWaitMilliseconds: 0 });
}
