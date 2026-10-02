import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { TangoTargetManager } from '../dist/services/tango/discovery/targetManager.js';

test('Tango targets survive repeated atomic replacements and accept whitespace separators', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'tango-targets-'));
    const file = path.join(root, 'tango.txt');
    await writeFile(file, 'https://tango.me/one first\n');
    const manager = TangoTargetManager.create(file);
    t.after(async () => { manager.close(); await rm(root, { recursive: true, force: true }); });
    for (const [id, alias] of [['two', 'second'], ['three', 'third']]) {
        await writeFile(path.join(root, 'replacement'), `# comment\nhttps://tango.me/${id}/\t  ${alias}\n`);
        await rename(path.join(root, 'replacement'), file);
        for (let n = 0; n < 40 && !manager.hasTarget(id); n++) await setTimeout(50);
        assert.deepEqual(manager.getTargets(), [{ accountId: id, alias }]);
    }
});
