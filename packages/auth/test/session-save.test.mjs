import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { AuthContext } from '../dist/auth/authContext.js';
import { getConfig } from '../dist/common/config.js';
import logger from '../dist/common/logger.js';

const provider = { serializeTokens: bag => structuredClone(bag) };
const bag = value => ({ refreshToken: value, sessionToken: value, extras: {} });

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-session-save-'));
    const config = getConfig();
    const originalPath = config.sessionPath;
    config.sessionPath = directory;
    const errors = [];
    t.mock.method(logger, 'error', (...args) => errors.push(args));
    t.after(async () => {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        config.sessionPath = originalPath;
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { context: new AuthContext('fixture@example.invalid', provider),
        file: path.join(directory, 'fixture@example.invalid.json'), errors };
}

test('overlapping stream and session saves commit the rotated token last', async t => {
    const { context, file, errors } = await fixture(t);
    const writeFile = fs.writeFile;
    let writes = 0;
    let releaseFirst;
    let firstWritten;
    const held = new Promise(resolve => { releaseFirst = resolve; });
    const started = new Promise(resolve => { firstWritten = resolve; });
    t.mock.method(fs, 'writeFile', async (...args) => {
        writes++;
        await writeFile(...args);
        if (writes === 1) {
            firstWritten();
            await held;
        }
    });
    syncBuiltinESMExports();

    context.updateFromLogin(bag('old-token'));
    const first = context.saveTokenToFile();
    await started;
    context.updateFromLogin(bag('rotated-token'));
    const second = context.saveTokenToFile();
    const writesBeforeFirstCommit = writes;
    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(writesBeforeFirstCommit, 1, 'the next save must wait for the first rename');
    assert.deepEqual(errors, []);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).refreshToken, 'rotated-token');
    assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
});

test('a failed save does not prevent a later token from being saved', async t => {
    const { context, file, errors } = await fixture(t);
    const writeFile = fs.writeFile;
    let writes = 0;
    t.mock.method(fs, 'writeFile', async (...args) => {
        if (++writes === 1) throw new Error('fixture write failure');
        return writeFile(...args);
    });
    syncBuiltinESMExports();
    context.updateFromLogin(bag('old-token'));
    const first = context.saveTokenToFile();
    context.updateFromLogin(bag('rotated-token'));
    const second = context.saveTokenToFile();
    await Promise.all([first, second]);

    assert.equal(errors.length, 1);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).refreshToken, 'rotated-token');
});
