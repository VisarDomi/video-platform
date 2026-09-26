import test from 'node:test';
import assert from 'node:assert/strict';
import { TangoAuthProvider } from '../dist/providers/tango/tangoAuthProvider.js';
import { requestQueue } from '../dist/auth/authQueue.js';
import { AuthService } from '../dist/auth/authService.js';

const token = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

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
