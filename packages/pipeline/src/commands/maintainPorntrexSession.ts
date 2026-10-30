import type { PipelineConfig } from '../config.js';
import { PipelineDatabase } from '../db/pipelineDatabase.js';
import { notifyDesktop } from '../notify.js';
import { checkPorntrexSession, type SessionCheck } from '../upload/porntrexKeepalive.js';
import { readPorntrexSession, sessionFingerprint } from '../upload/porntrexSession.js';
import { readRecoveryState, writeRecoveryState, withRecoveryLock, RecoveryDeferredError } from '../upload/sessionRecoveryState.js';
import { recoverPorntrexSession } from './recoverPorntrexSession.js';
import { SESSION_LOST_ADVICE } from '../upload/providerWarnings.js';

interface Dependencies {
    check: (sessionFile: string) => Promise<SessionCheck>;
    notify: (title: string, message: string) => unknown;
    recover?: (allowPasswordLogin: boolean) => Promise<void>;
}
const defaults = (config: PipelineConfig): Dependencies => ({ check: checkPorntrexSession,
    notify: (title, message) => notifyDesktop(title, message, true),
    ...(process.env.VIDEO_PTREX_AUTO_RECOVER === '1' ? { recover: (allow: boolean) => recoverPorntrexSession(config, allow) } : {}) });

export async function maintainPorntrexSession(config: PipelineConfig, now = new Date(), dependencies = defaults(config),
    options: { syncPhone?: boolean } = {}): Promise<{ disposition: string; fingerprint?: string | null; note?: string }> {
    const file = config.porntrexSessionPath;
    if (!file) return { disposition: 'not_configured' };
    const database = new PipelineDatabase(config.databasePath);
    try {
        const stored = await readPorntrexSession(file);
        const connected = database.listProviderSessionEvents('porntrex').filter(e => e.kind === 'phone_connected' && e.loggedIn).at(-1);
        const pending = !!stored && (!connected || connected.fingerprint !== sessionFingerprint(stored.cookies)
            || connected.passwordLoginAt !== stored.passwordLoginAt);
        const control = database.getCampaignControl();
        const authPaused = control.state === 'paused' && control.attentionReason?.includes(SESSION_LOST_ADVICE);
        const latestCheck = database.listProviderSessionEvents('porntrex').filter(e => e.kind === 'keepalive').at(-1);
        const knownLoss = control.state === 'paused' && latestCheck?.loggedIn === false;
        if (database.campaignIsActive(now) && !authPaused && !knownLoss && !pending && !options.syncPhone) return { disposition: 'worker_active' };
        const locked = await withRecoveryLock(config.databasePath, async () => {
            const previous = database.listProviderSessionEvents('porntrex').filter(e => e.kind === 'keepalive').at(-1);
            let result: SessionCheck;
            try { result = await dependencies.check(file); }
            catch (error) {
                const note = error instanceof Error ? error.message : String(error);
                database.recordProviderSessionEvent({ provider: 'porntrex', kind: 'keepalive_error', note }, now);
                return { disposition: 'unavailable', note };
            }
            database.recordProviderSessionEvent({ provider: 'porntrex', kind: 'keepalive', loggedIn: result.loggedIn,
                fingerprint: result.fingerprint, passwordLoginAt: result.passwordLoginAt,
                note: `${result.note}; independent session maintenance` }, now);
            const state = await readRecoveryState(config.databasePath);
            // A crash can happen after server authentication but before saving
            // the new login timestamp. PHP may reuse the same cookie value, so
            // an unfinished recovery still requires a phone acknowledgement.
            const needsPhone = result.loggedIn && (pending || options.syncPhone
                || state.status !== undefined && state.status !== 'healthy');
            if (!result.loggedIn && database.campaignIsActive(now) && database.getCampaignControl().state === 'running') {
                return { disposition: 'waiting_for_worker_pause' };
            }
            if (result.loggedIn && !needsPhone) {
                if (state.status !== 'healthy') await writeRecoveryState(config.databasePath, { version: 1, failures: 0, status: 'healthy' });
                return { disposition: 'logged_in', fingerprint: result.fingerprint };
            }
            if (!dependencies.recover) {
                if (!result.loggedIn && previous?.loggedIn !== false) dependencies.notify('Porntrex shared session needs recovery', 'The phone and PC share this session.');
                return { disposition: result.loggedIn ? 'phone_pending' : 'logged_out', fingerprint: result.fingerprint };
            }
            const coolingDown = Date.parse(state.retryAfter ?? '') > now.getTime();
            if (coolingDown && !(result.loggedIn && state.status !== 'phone_pending') && !(needsPhone && options.syncPhone)) {
                return { disposition: needsPhone ? 'phone_pending' : 'recovery_backoff', note: state.retryAfter };
            }
            // Two independent, uncached authentication failures are required.
            // HTTP/CDN errors, or a changed/recovered session, never trigger login.
            if (!result.loggedIn) {
                let confirmed: SessionCheck;
                try { confirmed = await dependencies.check(file); }
                catch { return { disposition: 'unavailable', note: 'Authentication loss could not be confirmed' }; }
                if (confirmed.loggedIn || confirmed.fingerprint !== result.fingerprint
                    || confirmed.passwordLoginAt !== result.passwordLoginAt) return { disposition: 'session_changed' };
            }
            const failures = state.failures + 1;
            // Persist before any external operation, so a crash cannot cause a login storm.
            await writeRecoveryState(config.databasePath, { version: 1, failures, status: needsPhone ? 'phone_pending' : 'recovering',
                retryAfter: new Date(now.getTime() + (needsPhone ? 10 : 30) * 60_000).toISOString() });
            try {
                await dependencies.recover(!result.loggedIn);
                const verified = await dependencies.check(file);
                if (!verified.loggedIn) throw new Error('Recovered session did not pass verification');
                await writeRecoveryState(config.databasePath, { version: 1, failures: 0, status: 'healthy' });
                return { disposition: needsPhone ? 'phone_synced' : 'recovered', fingerprint: verified.fingerprint };
            } catch (error) {
                const note = error instanceof Error ? error.message : String(error);
                const after = await readPorntrexSession(file);
                const pcRenewed = after && (after.passwordLoginAt !== stored?.passwordLoginAt
                    || sessionFingerprint(after.cookies) !== sessionFingerprint(stored?.cookies ?? []));
                await writeRecoveryState(config.databasePath, { version: 1,
                    failures: error instanceof RecoveryDeferredError ? state.failures : failures,
                    status: needsPhone || pcRenewed ? 'phone_pending' : 'recovery_failed',
                    retryAfter: new Date(now.getTime() + (needsPhone || pcRenewed || error instanceof RecoveryDeferredError ? 10 * 60_000
                        : Math.min(6 * 60, 30 * 2 ** Math.min(failures - 1, 4)) * 60_000)).toISOString(), lastError: note });
                database.recordProviderSessionEvent({ provider: 'porntrex', kind: 'keepalive_error', note: `Recovery deferred: ${note}` }, now);
                if (!(error instanceof RecoveryDeferredError) && !needsPhone && !pcRenewed && failures === 3) {
                    dependencies.notify('Porntrex automatic recovery is failing', 'Recovery is rate-limited and will retry. Check the session-maintenance journal for the failure; upload intent is unchanged.');
                }
                return { disposition: needsPhone || pcRenewed ? 'phone_pending' : 'recovery_deferred', note };
            }
        });
        return locked.acquired ? locked.value : { disposition: 'recovery_busy' };
    } finally { database.close(); }
}
