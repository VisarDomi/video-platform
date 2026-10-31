import test from 'node:test';
import assert from 'node:assert/strict';
import { Fc2Client } from '../dist/services/fc2/api/fc2Client.js';
import logger from '../dist/common/logger.js';

const transportFailure = () => Object.assign(new TypeError('fetch failed'), {
    cause: new AggregateError([Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
        Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]),
});

test('FC2 retries a transient transport failure and returns the successful discovery snapshot', async () => {
    let calls = 0;
    const client = { latestBroadcasts: new Map(), _request: async () => {
        if (++calls === 1) throw transportFailure();
        return Response.json({ channel: [{ id: 123, start_time: '2026-10-31T00:00:00Z', pay: 0 }] });
    } };
    const snapshot = await Fc2Client.prototype.getAdultChannelList.call(client);
    assert.equal(calls, 2);
    assert.equal(snapshot.get('123').startTime, '2026-10-31T00:00:00Z');
    assert.equal(client.latestBroadcasts, snapshot);
});

test('FC2 bounds transport retries, retains the prior snapshot and records underlying error codes', async t => {
    const messages = [];
    t.mock.method(logger, 'error', (...args) => messages.push(args));
    let calls = 0;
    const previous = new Map([['old', { channelId: 'old' }]]);
    const client = { latestBroadcasts: previous, _request: async () => { calls++; throw transportFailure(); } };
    assert.equal(await Fc2Client.prototype.getAdultChannelList.call(client), null);
    assert.equal(calls, 2);
    assert.equal(client.latestBroadcasts, previous);
    assert.deepEqual(messages.at(-1)[1].transportCodes, ['ECONNRESET', 'ETIMEDOUT']);
});

test('FC2 never converts an unknown JSON response into an authoritative empty channel list', async () => {
    let calls = 0;
    const previous = new Map([['old', { channelId: 'old' }]]);
    const client = { latestBroadcasts: previous, _request: async () => { calls++; return Response.json({ error: 'unavailable' }); } };
    assert.equal(await Fc2Client.prototype.getAdultChannelList.call(client), null);
    assert.equal(calls, 1);
    assert.equal(client.latestBroadcasts, previous);
    client._request = async () => new Response('denied', { status: 403 });
    assert.equal(await Fc2Client.prototype.getAdultChannelList.call(client), null);
    client._request = async () => Response.json({ channel: [] });
    assert.equal((await Fc2Client.prototype.getAdultChannelList.call(client)).size, 0);
});
