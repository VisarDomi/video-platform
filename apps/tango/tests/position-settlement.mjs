import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Deterministic frames drive the production sampler. These assertions describe
// observable callback behavior, not private fields or a Safari momentum model.
const source = readFileSync(new URL('../src/core/position-settlement.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
let time = 0, nextId = 0, calls = 0;
let position = [0, 0, 800];
const frames = new Map();
const context = vm.createContext({ exports: {}, performance: { now: () => time },
    requestAnimationFrame: callback => { frames.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: id => frames.delete(id) });
vm.runInContext(compiled, context);
const sampler = new context.exports.PositionSettlement(() => [...position], () => calls++);
const step = elapsed => {
    time += elapsed;
    const ready = [...frames.values()];
    frames.clear();
    ready.forEach(callback => callback(time));
};
const quiet = () => { for (let i = 0; i < 10; i++) step(10); };

sampler.watch();
for (let i = 0; i < 9; i++) { sampler.watch(); step(10); }
assert.equal(calls, 0);
step(10);
assert.equal(calls, 1, 'Repeated requests coalesce; quiet position settles without scrollend');
assert.equal(frames.size, 0, 'No sampling loop when idle');

sampler.watch();
for (let i = 0; i < 20; i++) { position[1] += 0.2; step(10); }
assert.equal(calls, 1, 'Continuing scroll prevents settlement');
quiet();
assert.equal(calls, 2);

sampler.watch();
for (let i = 0; i < 9; i++) step(10);
position[2] -= 20;
step(10);
assert.equal(calls, 2, 'Viewport movement resets the quiet window too');
quiet();
assert.equal(calls, 3);

sampler.watch();
step(300);
assert.equal(calls, 3, 'A stalled main thread does not prove a quiet compositor');
quiet();
assert.equal(calls, 4);

sampler.watch();
step(50);
sampler.cancel();
quiet();
assert.equal(calls, 4, 'Contact/pagehide cancellation drops pending work');
assert.equal(frames.size, 0);
sampler.watch();
quiet();
assert.equal(calls, 5, 'Fresh work can start after cancellation');
console.log('PASS: position quietness, viewport changes, continued motion, stalled frames, coalescing, cancellation and idle shutdown.');
