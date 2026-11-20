// Every browser this repository launches is the system's own, which the OS keeps updated
// (owner's security audit): code and tests pass an executablePath to every Playwright
// launch, and nothing downloads Playwright's browsers (they are never updated). Without
// an executablePath, Playwright silently falls back to a browser it downloaded.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = /\.(?:[cm]?[jt]sx?|svelte)$/;
const SKIP = new Set(['node_modules', 'dist', 'dist-server', 'build', '.git', '.svelte-kit', 'apps']);

function* files(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) yield* files(full);
        else if (entry.isFile()) yield full;
    }
}

// The argument text of each Playwright browser launch in a source text.
export function launches(source) {
    const found = [];
    for (const match of source.matchAll(/\b(?:chromium|webkit|firefox)\s*\.\s*launch(?:PersistentContext|Server)?\s*\(/g)) {
        let depth = 0, end = match.index + match[0].length - 1;
        for (; end < source.length; end++) {
            if (source[end] === '(') depth++;
            else if (source[end] === ')' && --depth === 0) break;
        }
        found.push({ index: match.index, call: source.slice(match.index, end + 1) });
    }
    return found;
}

test('the launch finder sees a launch without an executable', () => {
    const calls = launches('const b = await chromium.launch({ headless: true, args: [f(1)] });\nwebkit.launch({executablePath: p});\nchromium.launchPersistentContext.bind(chromium);');
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0].call, /executablePath/);
    assert.match(calls[1].call, /executablePath/);
});

test('every browser launch names its executable', () => {
    const missing = [];
    let seen = 0;
    for (const file of files(ROOT)) {
        if (!SOURCE.test(file) || file === fileURLToPath(import.meta.url)) continue;
        const source = readFileSync(file, 'utf8');
        for (const launch of launches(source)) {
            seen++;
            if (!/\bexecutablePath\b/.test(launch.call)) {
                const line = source.slice(0, launch.index).split('\n').length;
                missing.push(`${path.relative(ROOT, file)}:${line}`);
            }
        }
    }
    assert.ok(seen >= 6, `only ${seen} launches found: is the scan looking in the right place?`);
    assert.deepEqual(missing, [], 'these launches would run a browser Playwright downloaded');
});

// Production browsers open live websites, so they keep Chromium's sandbox, which Playwright
// turns off unless a launch asks for it.
test('every production browser launch keeps Chromium\'s sandbox', () => {
    const unsandboxed = [];
    let seen = 0;
    for (const file of files(ROOT)) {
        const relative = path.relative(ROOT, file);
        if (!SOURCE.test(file) || !/(?:^|\/)src\//.test(relative)) continue;
        const source = readFileSync(file, 'utf8');
        for (const launch of launches(source)) {
            seen++;
            if (!/\bchromiumSandbox\s*:\s*true\b/.test(launch.call)) unsandboxed.push(`${relative}:${source.slice(0, launch.index).split('\n').length}`);
        }
        // The VideoHost uploader launches through an injectable function.
        for (const match of source.matchAll(/this\.launchContext\(/g)) {
            seen++;
            const call = launches(source.slice(match.index).replace(/^this\.launchContext\(/, 'chromium.launch('))[0]?.call ?? '';
            if (!/\bchromiumSandbox\s*:\s*true\b/.test(call)) unsandboxed.push(`${relative}:${source.slice(0, match.index).split('\n').length}`);
        }
    }
    assert.ok(seen >= 3, `only ${seen} production launches found`);
    assert.deepEqual(unsandboxed, []);
});

test('nothing downloads or points at Playwright\'s browsers', () => {
    const offending = [];
    for (const file of files(ROOT)) {
        const name = path.basename(file);
        if (name !== 'package.json' && !SOURCE.test(file) && !/\.(?:service|sh|conf)$/.test(name)) continue;
        if (file === fileURLToPath(import.meta.url)) continue;
        const text = readFileSync(file, 'utf8');
        if (/playwright(?:-core)?\s+install\b|ms-playwright|\.local-browsers|PLAYWRIGHT_BROWSERS_PATH\s*(?:\?\?=|=|:)\s*["']?(?:0|\/|~|\$HOME)/.test(text)) offending.push(path.relative(ROOT, file));
    }
    assert.deepEqual(offending, []);
});
