// Builds the Safari extensions the iPhone app hosts, from the sites file: each site
// plug-in's download-list bar and each file host plug-in's send-to-PC extension (declared
// by the plug-in's extension.json), for the PC and the app its "extensions" block names:
//
//   { "extensions": { "pc": "https://192.168.1.10", "hostApp": "Live" }, "sites": [ ... ] }
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFileHosts, parseSitesFile } from 'sdk';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const sitesFile = process.env.VIDEO_SITES_FILE
    ?? join(process.env.VIDEO_SERVICES_DATA_ROOT ?? join(os.homedir(), '.local', 'share', 'video-services'), 'sites.json');
const text = await readFile(sitesFile, 'utf8');
// The deployment: the PC the extensions talk to (its server on :9999, its file hosts on
// :9998), and the app that hosts them.
const settings = JSON.parse(text).extensions ?? {};
const PC = settings.pc ?? 'https://localhost';
const HOST_APP = settings.hostApp ?? 'the iPhone app';

async function specOf(entry, kind) {
    const directory = dirname(require.resolve(`${entry.plugin}/package.json`));
    const specFile = join(directory, 'extension.json');
    if (!existsSync(specFile)) return null;
    const spec = JSON.parse(await readFile(specFile, 'utf8'));
    if (spec.kind !== kind) throw new Error(`${specFile}: expected an extension of kind ${kind}, not ${JSON.stringify(spec.kind)}`);
    return { ...spec, api: `/api/${entry.id}`, module: resolve(directory, spec.entry),
        ...(spec.background ? { backgroundModule: resolve(directory, spec.background) } : {}) };
}
const EXTENSIONS = {};
for (const entry of parseSitesFile(text, sitesFile)) {
    if (entry.enabled === false) continue;
    const spec = await specOf(entry, 'download-list');
    if (spec) EXTENSIONS[spec.key] = spec;
}
for (const entry of parseFileHosts(text, sitesFile)) {
    const spec = await specOf(entry, 'send-to-pc');
    if (spec) EXTENSIONS[spec.key] = spec;
}

// A download-list bar's content script: the plug-in's page code, then the bar once the
// page has a body (a document_start script runs before it does).
function downloadListEntry(extension) {
    const module = JSON.stringify(extension.module);
    return extension.runAt === 'document_start' ? `import { mountDownloadListBar } from "../core/downloadListBar";
import { adapter, onDocumentStart } from ${module};

onDocumentStart();

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => mountDownloadListBar(adapter), { once: true });
} else {
    mountDownloadListBar(adapter);
}
` : `import { mountDownloadListBar } from "../core/downloadListBar";
import { adapter } from ${module};

mountDownloadListBar(adapter);
`;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXTENSIONS);
for (const key of names) {
    const extension = EXTENSIONS[key];
    if (!extension) throw new Error(`Usage: node scripts/build.mjs [${Object.keys(EXTENSIONS).join('|')}]`);
    // A file host's extension sends pages to the PC's file-host service; a bar edits a list.
    const sendToPc = extension.kind === 'send-to-pc';
    const server = `${PC}:${sendToPc ? 9998 : 9999}`;
    const out = resolve(root, '../../dist/extension', key);
    await mkdir(out, { recursive: true });
    const common = { bundle: true, minify: true, format: 'iife', target: 'safari17', logLevel: 'warning', loader: { '.css': 'text' } };
    const define = { __API_PATH__: JSON.stringify(extension.api), __PC_SERVER__: JSON.stringify(server) };
    await build({ ...common, outfile: resolve(out, 'content.js'), ...(sendToPc
        ? { entryPoints: [extension.module] }
        : { stdin: { contents: downloadListEntry(extension), resolveDir: resolve(root, 'src/extension'), sourcefile: resolve(root, 'src/extension', `${key}.ts`), loader: 'ts' }, tsconfig: resolve(root, 'tsconfig.json') }) });
    await build({ ...common, entryPoints: [sendToPc ? extension.backgroundModule : resolve(root, 'src/extension/background.ts')],
        outfile: resolve(out, 'background.js'), define });
    await writeFile(resolve(out, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: extension.name, version: extension.version ?? '1.0.0',
        description: sendToPc ? `Send ${extension.siteName} video downloads to your PC on the home network. Hosted by ${HOST_APP}.`
            : `Add or remove the open ${extension.siteName} streamer from the PC download list. Hosted by ${HOST_APP}.`,
        host_permissions: [...extension.matches, `${server}/*`],
        background: { scripts: ['background.js'], service_worker: 'background.js', persistent: false },
        content_scripts: sendToPc
            ? extension.contentScripts.map((script) => ({ matches: extension.matches.map((url) => url.replace('/*', script.path)),
                js: ['content.js'], run_at: script.runAt, all_frames: false }))
            : [{ matches: extension.matches, js: ['content.js'], run_at: extension.runAt, all_frames: false }],
    }, null, 2) + '\n');
    console.log(`Built ${extension.name} into dist/extension/${key}`);
}
