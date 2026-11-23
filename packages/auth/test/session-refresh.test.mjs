import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../dist/auth/authService.js';

// The core's own refresh mechanics with fake sites. (A real site's session requests are
// tested with its plug-in.)

// A renewal used to drop a stream-token answer that arrived after it replaced the session;
// with 10-second tokens refreshed every 5 s, that let them lapse (a playlist 401 on
// 2026-11-22 21:27, 9.6 s after the last write).
const streamSite = (fetchShortTokens) => ({ fetchShortTokens,
    describeTokens: bag => ({ ...(bag.extras.tte ? { shortExpiresAt: Number(bag.extras.tte) * 1000 } : {}), summary: `tte=${bag.extras.tte || 'none'}` }) });

test('a renewal during a stream-token request keeps its newer stream tokens, never its old session', async () => {
    let resolve;
    const service = new AuthService({ email: 'fixture@example.invalid', password: 'unused', provider: 'live-a' }, streamSite(() => new Promise(r => { resolve = r; })));
    service.authContext.updateFromLogin({ refreshToken: 'old-refresh', sessionToken: 'old-access', extras: { browserState: 'retained-state', tte: '1000' } });
    const request = service.setTokenData();
    service.authContext.updateFromRefresh({ newRefreshToken: 'new-refresh', newSessionToken: 'new-access', extras: { browserState: 'fresh-state' } });
    resolve({ extras: { tt: 'late-stream-token', ttu: 'late', tte: '9999999999' },
        session: { newRefreshToken: 'stale-refresh', newSessionToken: 'stale-access' } });
    await request;
    assert.deepEqual(service.authContext.getTokenBag(), { refreshToken: 'new-refresh', sessionToken: 'new-access',
        extras: { browserState: 'fresh-state', tt: 'late-stream-token', ttu: 'late', tte: '9999999999' } });
});

test('a late stream-token answer never replaces newer stream tokens', async () => {
    let resolve;
    const service = new AuthService({ email: 'fixture@example.invalid', password: 'unused', provider: 'live-a' }, streamSite(() => new Promise(r => { resolve = r; })));
    service.authContext.updateFromLogin({ refreshToken: 'old-refresh', sessionToken: 'old-access', extras: {} });
    const request = service.setTokenData();
    service.authContext.updateFromRefresh({ newRefreshToken: 'new-refresh', newSessionToken: 'new-access', extras: { tt: 'fresh', ttu: 'fresh', tte: '2000' } });
    resolve({ extras: { tt: 'late', ttu: 'late', tte: '1500' } });
    await request;
    assert.equal(service.authContext.getTokenBag().extras.tt, 'fresh');
});

test('a stream-token refresh unanswered for a second is hedged by a parallel request', async () => {
    let calls = 0;
    const provider = {
        // The first request hangs; the second answers at once.
        fetchShortTokens: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve({extras:{tt:'t', ttu:'u', tte:'9999999999'}}),
    };
    const service = new AuthService({email:'test@example.invalid',password:'fixture',provider:'live-a'}, provider);
    service.authContext.updateFromLogin({refreshToken:'refresh',sessionToken:'access',extras:{}});
    const started = Date.now();
    await service.setTokenData(true);
    assert.equal(calls, 2);
    assert.ok(Date.now() - started < 2000);
    assert.equal(service.authContext.getTokenBag().extras.tte, '9999999999');
});

test('a quick stream-token answer sends no second request', async () => {
    let calls = 0;
    const provider = { fetchShortTokens: async () => { calls++; return {extras:{tt:'t', ttu:'u', tte:'9999999999'}}; } };
    const service = new AuthService({email:'test@example.invalid',password:'fixture',provider:'live-a'}, provider);
    service.authContext.updateFromLogin({refreshToken:'refresh',sessionToken:'access',extras:{}});
    await service.setTokenData(true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(calls, 1);
});

// ---- the site's decisions and token description (generic sites) ----

class Rejected extends Error {}
class Verify extends Error {}
class Person extends Error {}
class Expired extends Error {}
const demo = (extra = {}) => ({
    intervals: { shortTokenRefresh: 5000, sessionRefresh: 1800000 },
    classify: error => error instanceof Person ? 'needs-attention' : error instanceof Verify ? 'verification'
        : error instanceof Rejected ? 'reauthenticate' : error instanceof Expired ? 'expired' : 'outage',
    describeTokens: bag => ({ ...(bag.extras.short ? { shortExpiresAt: Number(bag.extras.short) * 1000 } : {}),
        summary: `short=${bag.extras.short || 'none'}` }),
    ...extra,
});
function recorder() {
    const lines = [];
    const log = Object.fromEntries(['debug', 'verbose', 'info', 'warn', 'error'].map(level => [level, message => lines.push([level, message])]));
    return { log, lines };
}
const account = { email: 'fixture@example.invalid', password: 'unused', provider: 'demo' };

test("a verification request signs in again and names the site; a rejection says the token became invalid", async (t) => {
    const { default: logger } = await import('../dist/common/logger.js');
    const warnings = [];
    t.mock.method(logger, 'warn', message => warnings.push(message));
    for (const error of [new Verify('check'), new Rejected('Token data fetch failed with status 401')]) {
        let logins = 0;
        const service = new AuthService(account, demo({ refreshSession: async () => { throw error; } }), { label: 'Demo', log: recorder().log });
        service.authContext.updateFromLogin({ refreshToken: 'refresh', sessionToken: 'access', extras: {} });
        service.performFreshLogin = async () => { logins++; };
        await service.maintainSession();
        assert.equal(logins, 1);
    }
    assert.deepEqual(warnings, [
        'Demo requested browser verification for fixture@example.invalid; completing the normal browser login.',
        'Token became invalid during maintenance for fixture@example.invalid. Attempting fresh browser login.',
    ]);
});

test("needs-attention stops automatic sign-ins, and a later sign-in reports the same failure", async (t) => {
    const { default: logger } = await import('../dist/common/logger.js');
    const errors = [];
    t.mock.method(logger, 'error', message => errors.push(message));
    const person = new Person('A person has to look at the sign-in.');
    let logins = 0;
    const service = new AuthService(account, demo({
        refreshSession: async () => { throw new Rejected('Session refresh failed with status 403.'); },
        login: async () => { logins++; throw person; },
    }), { label: 'Demo', log: recorder().log });
    service.authContext.updateFromLogin({ refreshToken: 'refresh', sessionToken: 'access', extras: {} });
    await service.maintainSession();
    await service.maintainSession();
    assert.equal(logins, 1);
    // The sign-in itself is a bug event: the session is meant to live on its refresh token.
    assert.deepEqual(errors, [
        '[bug event] Demo browser sign-in for fixture@example.invalid: the session renewal was refused: Session refresh failed with status 403.',
        'A person has to look at the sign-in.',
    ]);
    await assert.rejects(service.performFreshLogin(), error => error === person);
});

test("a token write names the short tokens as the site does and warns when they lapse before the next refresh", async () => {
    const { log, lines } = recorder();
    const service = new AuthService(account, demo(), { label: 'Demo', log });
    const now = Math.floor(Date.now() / 1000);
    service.authContext.updateFromLogin({ refreshToken: 'refresh', sessionToken: 'access', extras: {} });
    service.logTokenWrite('login');
    service.authContext.updateFromLogin({ refreshToken: 'refresh', sessionToken: 'access', extras: { short: String(now + 2) } });
    service.logTokenWrite('init');
    service.authContext.updateFromLogin({ refreshToken: 'refresh', sessionToken: 'access', extras: { short: String(now + 60) } });
    service.logTokenWrite('resume');
    assert.deepEqual(lines.map(([level, message]) => [level, message.replace(/ttl=\d+s/, 'ttl=Ns')]), [
        ['warn', 'Token write — source=login short=none'],
        ['warn', `Token write — source=init short=${now + 2} ttl=Ns (below 5s refresh cycle)`],
        ['debug', `Token write — source=resume short=${now + 60} ttl=Ns`],
    ]);
});

test("a refresh token at its own expiry signs in as the expected event; a refused session is a bug event", async (t) => {
    const { default: logger } = await import('../dist/common/logger.js');
    const lines = [];
    for (const level of ['info', 'warn', 'error']) t.mock.method(logger, level, message => lines.push([level, message]));
    for (const error of [new Expired('the refresh token expired on 2027-02-21T08:46:51.000Z'), new Rejected('Session refresh failed with status 401')]) {
        const service = new AuthService(account, demo({ refreshSession: async () => { throw error; }, login: async () => { throw new Person('stop here'); } }),
            { label: 'Demo', log: recorder().log });
        service.authContext.updateFromLogin({ refreshToken: 'refresh', sessionToken: 'access', extras: {} });
        await service.maintainSession();
    }
    const signIns = lines.filter(([, message]) => /browser sign-in/.test(message));
    assert.deepEqual(signIns, [
        ['info', 'Demo browser sign-in for fixture@example.invalid: the refresh token expired on 2027-02-21T08:46:51.000Z'],
        ['error', '[bug event] Demo browser sign-in for fixture@example.invalid: the session renewal was refused: Session refresh failed with status 401'],
    ]);
});
