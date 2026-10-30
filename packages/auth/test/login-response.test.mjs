import test from 'node:test';
import assert from 'node:assert/strict';
import { isTangoLoginResponse } from '../dist/providers/tango/tangoLogin.js';

test('capture recognizes both current first-party and legacy login responses',()=>{
    assert.equal(isTangoLoginResponse('https://www.tango.me/api/google-login/auth-code/v1/login',200),true);
    assert.equal(isTangoLoginResponse('https://gateway.tango.me/google-login/auth-code/v1/login',200),true);
    assert.equal(isTangoLoginResponse('https://www.tango.me/api/google-login/auth-code/v1/login',424),false);
    assert.equal(isTangoLoginResponse('https://tango.me.evil.invalid/api/google-login/auth-code/v1/login',200),false);
    assert.equal(isTangoLoginResponse('https://example.invalid/google-login/auth-code/v1/login',200),false);
    assert.equal(isTangoLoginResponse('http://www.tango.me/api/google-login/auth-code/v1/login',200),false);
    assert.equal(isTangoLoginResponse('https://www.tango.me/api/session-service/public/v2/session/web/refresh',200),false);
    assert.equal(isTangoLoginResponse('not a URL',200),false);
});
