import test from 'node:test';
import assert from 'node:assert/strict';
import { TangoAuthProvider } from '../dist/providers/tango/tangoAuthProvider.js';
import { requestQueue } from '../dist/auth/authQueue.js';
import { AuthService } from '../dist/auth/authService.js';
import { BrowserVerificationRequiredError, BrowserLoginNeedsAttentionError } from '../dist/providers/interfaces.js';

const token = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

test('only an explicit 424 challenge requests browser recovery', async () => {
    const provider=new TangoAuthProvider(),original=requestQueue.add;
    const bag={refreshToken:token({accountId:'pc-account',sessionId:'pc-session'}),sessionToken:'access',extras:{}};
    try {
        requestQueue.add=async()=>new Response(JSON.stringify({errorCode:'CHALLENGE_REQUIRED'}),{status:424});
        await assert.rejects(provider.refreshSession(bag),BrowserVerificationRequiredError);
        requestQueue.add=async()=>new Response(JSON.stringify({errorCode:'DEPENDENCY_UNAVAILABLE'}),{status:424});
        await assert.rejects(provider.refreshSession(bag),e=>!(e instanceof BrowserVerificationRequiredError)&&/status 424/.test(e.message));
        requestQueue.add=async()=>new Response('unavailable',{status:503});
        await assert.rejects(provider.refreshSession(bag),e=>!(e instanceof BrowserVerificationRequiredError)&&/status 503/.test(e.message));
    } finally {requestQueue.add=original;}
});

test('a maintenance challenge uses the existing browser recovery once', async () => {
    let logins=0;
    const provider={intervals:{shortTokenRefresh:5000,sessionRefresh:1800000},refreshSession:async()=>{throw new BrowserVerificationRequiredError();}};
    const service=new AuthService({email:'test@example.invalid',password:'fixture',provider:'tango'},provider);
    service.authContext.updateFromLogin({refreshToken:'refresh',sessionToken:token({exp:1}),extras:{}});
    service.performFreshLogin=async()=>{logins++;};
    await service.maintainSession();assert.equal(logins,1);
});

test('manual verification stops repeated password logins',async()=>{
    let logins=0;
    const provider={intervals:{shortTokenRefresh:5000,sessionRefresh:1800000},
        refreshSession:async()=>{throw new BrowserVerificationRequiredError();},
        login:async()=>{logins++;throw new BrowserLoginNeedsAttentionError();}};
    const service=new AuthService({email:'test@example.invalid',password:'fixture',provider:'tango'},provider);
    service.authContext.updateFromLogin({refreshToken:'refresh',sessionToken:token({exp:1}),extras:{}});
    await service.maintainSession();await service.maintainSession();
    assert.equal(logins,1);
});

test('a stream-token failure after fresh recovery does not rotate the fresh session again', async () => {
    let refreshes=0,streams=0;
    const provider={intervals:{shortTokenRefresh:5000,sessionRefresh:1800000},
        refreshSession:async()=>{refreshes++;return {newSessionToken:token({exp:Math.floor(Date.now()/1000)+3600}),newRefreshToken:'new-refresh'};},
        fetchShortTokens:async()=>{if(++streams===1)throw new Error('temporary stream network failure');return {extras:{tt:'t',ttu:'u',tte:'9999999999'}};}};
    const service=new AuthService({email:'test@example.invalid',password:'fixture',provider:'tango'},provider);
    service.authContext.updateFromLogin({refreshToken:'refresh',sessionToken:token({exp:1}),extras:{}});service.authContext.saveTokenToFile=async()=>{};
    await assert.rejects(service.ensureValidTokens('session-maintain'),/temporary/);
    await service.ensureValidTokens('session-maintain');assert.equal(refreshes,1);assert.equal(streams,2);
});

test('restart validates a fresh saved session without rotating its refresh token', async () => {
    let refreshes = 0, shortTokens = 0;
    const provider = {
        intervals: {shortTokenRefresh:5000,sessionRefresh:1800000},
        refreshSession: async () => { refreshes++; throw new Error('Unexpected rotation'); },
        fetchShortTokens: async () => { shortTokens++; return {extras:{tt:'t',ttu:'u',tte:'9999999999'}}; },
    };
    const service = new AuthService({email:'test@example.invalid',password:'fixture',provider:'tango'},provider);
    service.authContext.updateFromLogin({refreshToken:'refresh',sessionToken:token({exp:Math.floor(Date.now()/1000)+3600}),extras:{}});
    service.authContext.loadTokenFromFile = async () => true;
    service.authContext.saveTokenToFile = async () => {};
    await service.initiateAuth();
    assert.equal(refreshes,0);assert.equal(shortTokens,1);
});

test('a saved access token rejected by the server falls back to its own refresh token', async () => {
    let refreshes = 0, shortTokens = 0;
    const provider = {
        intervals: {shortTokenRefresh:5000,sessionRefresh:1800000},
        refreshSession: async () => { refreshes++; return {newSessionToken:'renewed-access',newRefreshToken:'renewed-refresh'}; },
        fetchShortTokens: async () => { if (++shortTokens===1) throw new Error('Token data fetch failed with status 401'); return {extras:{tt:'t',ttu:'u',tte:'9999999999'}}; },
    };
    const service = new AuthService({email:'test@example.invalid',password:'fixture',provider:'tango'},provider);
    service.authContext.updateFromLogin({refreshToken:'refresh',sessionToken:token({exp:Math.floor(Date.now()/1000)+3600}),extras:{}});
    service.authContext.loadTokenFromFile = async () => true;service.authContext.saveTokenToFile = async () => {};
    await service.initiateAuth();
    assert.equal(refreshes,1);assert.equal(shortTokens,2);assert.equal(service.authContext.getRefreshToken(),'renewed-refresh');
});

test('refresh uses the PC token claims and receives replacement cookies', async () => {
    const provider = new TangoAuthProvider();
    const refreshToken = token({accountId:'pc-account', sessionId:'pc-session'});
    const original = requestQueue.add;
    requestQueue.add = async (url, request) => {
        assert.equal(url, 'https://gateway.tango.me/session-service/public/v2/session/web/refresh');
        assert.equal(request.method, 'POST');
        assert.deepEqual(JSON.parse(request.body), {accountId:'pc-account', sessionId:'pc-session'});
        assert.equal(new Headers(request.headers).get('cookie'), `Tango-RT=${refreshToken}`);
        const headers = new Headers();
        headers.append('set-cookie', 'Tango-ST=new-access; Path=/');
        headers.append('set-cookie', 'Tango-RT=new-refresh; Path=/');
        return new Response(null, {status:200, headers});
    };
    try {
        assert.deepEqual(await provider.refreshSession({refreshToken, sessionToken:'old-access', extras:{}}),
            {newSessionToken:'new-access', newRefreshToken:'new-refresh'});
        await assert.rejects(provider.refreshSession({refreshToken:token({sessionId:'missing-account'}),sessionToken:null,extras:{}}),
            /missing accountId or sessionId/);
    } finally { requestQueue.add = original; }
});

test('persist rotated refresh token before a failing stream-token request', async () => {
    const writes = [];
    const provider = {
        refreshSession: async () => ({newSessionToken:'new-access', newRefreshToken:'new-refresh'}),
        fetchShortTokens: async () => {
            assert.deepEqual(writes, [{refreshToken:'new-refresh', sessionToken:'new-access', extras:{}}]);
            throw new Error('stream token connection interrupted');
        },
    };
    const service = new AuthService({email:'test@example.invalid',password:'fixture',provider:'tango'}, provider);
    service.authContext.updateFromLogin({refreshToken:'old-refresh',sessionToken:'old-access',extras:{}});
    service.authContext.saveTokenToFile = async () => writes.push(structuredClone(service.authContext.getTokenBag()));
    await assert.rejects(service.ensureValidTokens('test'), /stream token connection interrupted/);
    assert.equal(writes[0].refreshToken, 'new-refresh');
});

test('a stream-token refresh unanswered for a second is hedged by a parallel request', async () => {
    let calls = 0;
    const provider = {
        // The first request hangs; the second answers at once.
        fetchShortTokens: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve({extras:{tt:'t', ttu:'u', tte:'9999999999'}}),
    };
    const service = new AuthService({email:'test@example.invalid',password:'fixture',provider:'tango'}, provider);
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
    const service = new AuthService({email:'test@example.invalid',password:'fixture',provider:'tango'}, provider);
    service.authContext.updateFromLogin({refreshToken:'refresh',sessionToken:'access',extras:{}});
    await service.setTokenData(true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(calls, 1);
});
