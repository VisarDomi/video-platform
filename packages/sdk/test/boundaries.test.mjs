// The dependency rule (CONTRACTS.md, rule 1): the core depends on the SDK, plug-ins depend
// on the SDK, and nothing depends on a plug-in.
//
// - No `packages/*/src` file imports a `plugin-*` package or anything under `private/`.
// - A `private/plugins/*/src` file imports only `sdk`, `node:*` built-ins, its own files
//   (relative paths inside the plug-in) and the runtime dependencies its package.json
//   declares.
// - The server and the auth daemon reach other packages by name only (no path into a
//   package's files or build output; the phone setup used to import auth's dist by path).
//   Which site names their sources may still contain is checked with the private word
//   list in private/test/coreSiteNames.test.mjs.
//
// The private plug-ins leave this repository later; their half of the check then has
// nothing to scan.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = /\.(?:[cm]?[jt]sx?|svelte|vue)$/;

// Every module specifier written as a literal: static and dynamic imports, re-exports,
// side-effect imports and require().
export function importSpecifiers(source) {
    const patterns = [
        /\bfrom\s*["']([^"'\n]+)["']/g,
        /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
        /\bimport\s+["']([^"'\n]+)["']/g,
        /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
    ];
    const found = new Set();
    for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) found.add(match[1]);
    }
    return [...found];
}

function packageName(specifier) {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const isRelative = (specifier) => specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../');
const inside = (directory, file) => {
    const relative = path.relative(directory, file);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

// Why a core source file may not import this specifier, or null.
export function coreViolation(file, specifier, root = ROOT) {
    if (packageName(specifier).startsWith('plugin-')) return 'imports a plug-in package';
    const privateRoot = path.join(root, 'private');
    if (isRelative(specifier) && inside(privateRoot, path.resolve(path.dirname(file), specifier))) return 'imports from private/';
    if (path.isAbsolute(specifier) && inside(privateRoot, specifier)) return 'imports from private/';
    if (/(^|\/)private\//.test(specifier) && !isRelative(specifier)) return 'imports from private/';
    return null;
}

// Why a plug-in source file may not import this specifier, or null.
export function pluginViolation(file, specifier, pluginRoot, dependencies) {
    if (specifier.startsWith('node:')) return null;
    if (isRelative(specifier)) {
        return inside(pluginRoot, path.resolve(path.dirname(file), specifier)) ? null : 'imports outside its plug-in';
    }
    if (path.isAbsolute(specifier)) return 'imports an absolute path';
    const name = packageName(specifier);
    if (name === 'sdk') return null;
    if (dependencies.includes(name)) return null;
    return `imports ${name}, which is neither sdk, a node: built-in nor a declared dependency`;
}

function sourceFiles(directory) {
    if (!existsSync(directory)) return [];
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...sourceFiles(full));
        else if (SOURCE.test(entry.name)) files.push(full);
    }
    return files;
}

function subdirectories(directory) {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).map((name) => path.join(directory, name)).filter((full) => statSync(full).isDirectory());
}

test('no core package source imports a plug-in or anything under private/', () => {
    const violations = [];
    let scanned = 0;
    for (const packageRoot of subdirectories(path.join(ROOT, 'packages'))) {
        for (const file of sourceFiles(path.join(packageRoot, 'src'))) {
            scanned++;
            for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
                const why = coreViolation(file, specifier);
                if (why) violations.push(`${path.relative(ROOT, file)}: ${why} (${specifier})`);
            }
        }
    }
    assert.ok(scanned > 50, `only ${scanned} core source files found under ${ROOT}`);
    assert.deepEqual(violations, []);
});

// Why a source file of a service that loads its sites from the registry (the server, the
// auth daemon) may not import this specifier, or null: other packages are reached by
// name (their package root), never by a path into their files or their build output.
export function servicePackageViolation(file, specifier, packageRoot) {
    if (isRelative(specifier)) {
        return inside(packageRoot, path.resolve(path.dirname(file), specifier)) ? null : 'reaches into another package by path';
    }
    if (path.isAbsolute(specifier)) return 'imports an absolute path';
    const name = packageName(specifier);
    if (specifier !== name && /^(sdk|shared|auth|server|downloader|pipeline|descriptor|app)$/.test(name)) {
        return `imports ${specifier}, a path inside another workspace package`;
    }
    return null;
}

test('the server and the auth daemon reach other packages only by name, never by path', () => {
    const violations = [];
    let scanned = 0;
    for (const name of ['server', 'auth']) {
        const packageRoot = path.join(ROOT, 'packages', name);
        for (const file of sourceFiles(path.join(packageRoot, 'src'))) {
            scanned++;
            for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
                const why = servicePackageViolation(file, specifier, packageRoot);
                if (why) violations.push(`${path.relative(ROOT, file)}: ${why} (${specifier})`);
            }
        }
    }
    assert.ok(scanned > 40, `only ${scanned} server and auth source files found under ${ROOT}`);
    assert.deepEqual(violations, []);
});

test('plug-in sources import only sdk, node: built-ins, their own files and declared dependencies', () => {
    const violations = [];
    for (const pluginRoot of subdirectories(path.join(ROOT, 'private', 'plugins'))) {
        const manifest = JSON.parse(readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
        const dependencies = Object.keys(manifest.dependencies ?? {});
        for (const file of sourceFiles(path.join(pluginRoot, 'src'))) {
            for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
                const why = pluginViolation(file, specifier, pluginRoot, dependencies);
                if (why) violations.push(`${path.relative(ROOT, file)}: ${why} (${specifier})`);
            }
        }
    }
    assert.deepEqual(violations, []);
});

test('the checks catch what they forbid', () => {
    assert.deepEqual(importSpecifiers([
        'import { a } from "sdk";',
        "export * from './x.js';",
        'import "side-effect";',
        'const m = await import("plugin-demo");',
        "const r = require('fs');",
        'import type { T } from "../types.js";',
    ].join('\n')).sort(), ['../types.js', './x.js', 'fs', 'plugin-demo', 'sdk', 'side-effect'].sort());

    const root = '/repo';
    const core = '/repo/packages/downloader/src/services/x.ts';
    assert.match(coreViolation(core, 'plugin-demo', root), /plug-in/);
    assert.match(coreViolation(core, 'plugin-demo/dist/x.js', root), /plug-in/);
    assert.match(coreViolation(core, '../../../../private/plugins/demo/src/x.js', root), /private/);
    assert.match(coreViolation(core, '/repo/private/config/sites.json', root), /private/);
    assert.equal(coreViolation(core, 'sdk', root), null);
    assert.equal(coreViolation(core, '../common/logger.js', root), null);

    const server = '/repo/packages/server';
    const route = `${server}/src/api/providers/phone-session.routes.ts`;
    assert.match(servicePackageViolation(route, '../../../../auth/dist/phoneBrowserSession.js', server), /another package by path/);
    assert.match(servicePackageViolation(route, 'auth/dist/phoneBrowserSession.js', server), /inside another workspace package/);
    assert.match(servicePackageViolation(route, 'shared/dist/siteHost.js', server), /inside another workspace package/);
    assert.equal(servicePackageViolation(route, 'shared', server), null);
    assert.equal(servicePackageViolation(route, 'express', server), null);
    assert.equal(servicePackageViolation(route, '../../core/config.js', server), null);

    const plugin = '/repo/private/plugins/demo';
    const file = `${plugin}/src/client.ts`;
    assert.equal(pluginViolation(file, 'sdk', plugin, []), null);
    assert.equal(pluginViolation(file, 'node:fs', plugin, []), null);
    assert.equal(pluginViolation(file, './timing.js', plugin, []), null);
    assert.equal(pluginViolation(file, 'ws', plugin, ['ws']), null);
    assert.match(pluginViolation(file, 'fs', plugin, []), /neither sdk/);
    assert.match(pluginViolation(file, 'shared', plugin, []), /neither sdk/);
    assert.match(pluginViolation(file, 'downloader/dist/x.js', plugin, []), /neither sdk/);
    assert.match(pluginViolation(file, '../../other/src/x.js', plugin, []), /outside its plug-in/);
    assert.match(pluginViolation(file, '../../../../packages/downloader/src/x.js', plugin, []), /outside its plug-in/);
    assert.match(pluginViolation(file, '/repo/packages/shared/src/x.js', plugin, []), /absolute/);
});
