import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const mode of ['cleanup', 'during-navigation', 'popup-error']) test(`popup waiter failures stay owned by the login flow: ${mode}`, () => {
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict',
        fileURLToPath(new URL('./fixtures/popup-waiter.mjs', import.meta.url)), mode], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    assert.match(child.stdout, /handled original login failure and browser cleanup/);
});
