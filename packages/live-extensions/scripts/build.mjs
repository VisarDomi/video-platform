// Builds the Safari extensions the iPhone app hosts: each site plug-in's download-list bar
// (declared by the plug-in's extension.json, for the sites the sites file enables) and
// FileHost to PC.
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSitesFile } from 'sdk';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// The deployment: the PC the extensions talk to, the app that hosts them, its sites file.
const PC = 'https://192.168.1.197';
const HOST_APP = 'TsLive';
const sitesFile = process.env.VIDEO_SITES_FILE
    ?? join(process.env.VIDEO_SERVICES_DATA_ROOT ?? join(os.homedir(), '.local', 'share', 'video-services'), 'sites.json');

const EXTENSIONS = {};
for (const entry of parseSitesFile(await readFile(sitesFile, 'utf8'), sitesFile)) {
    if (entry.enabled === false) continue;
    const directory = dirname(require.resolve(`${entry.plugin}/package.json`));
    const specFile = join(directory, 'extension.json');
    if (!existsSync(specFile)) continue;
    const spec = JSON.parse(await readFile(specFile, 'utf8'));
    if (spec.kind !== 'download-list') throw new Error(`${specFile}: unknown extension kind ${JSON.stringify(spec.kind)}`);
    EXTENSIONS[spec.key] = { ...spec, api: `/api/${entry.id}`, module: resolve(directory, spec.entry) };
}
// FileHost's file-host extension keeps its sources here until FileHost becomes a plug-in.
EXTENSIONS.filehost = { kind: 'send-to-pc', name: 'FileHost to PC', siteName: 'FileHost', version: '1.1.1',
    matches: ['https://file-host.example/*', 'https://file-host.example/*', 'https://file-host.example/*'], api: '/api/filehost' };

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
    const filehost = extension.kind === 'send-to-pc';
    const out = resolve(root, '../../dist/extension', key);
    await mkdir(out, { recursive: true });
    const common = { bundle: true, minify: true, format: 'iife', target: 'safari17', logLevel: 'warning', loader: { '.css': 'text' } };
    await build({ ...common, outfile: resolve(out, 'content.js'), ...(filehost
        ? { entryPoints: [resolve(root, 'src/extension/filehost.ts')] }
        : { stdin: { contents: downloadListEntry(extension), resolveDir: resolve(root, 'src/extension'), sourcefile: resolve(root, 'src/extension', `${key}.ts`), loader: 'ts' }, tsconfig: resolve(root, 'tsconfig.json') }) });
    await build({ ...common, entryPoints: [resolve(root, filehost ? 'src/extension/filehost-background.ts' : 'src/extension/background.ts')], outfile: resolve(out, 'background.js'),
        define: { __API_PATH__: JSON.stringify(extension.api) } });
    await writeFile(resolve(out, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: extension.name, version: extension.version ?? '1.0.0',
        description: filehost ? `Send FileHost video downloads to your PC on the home network. Hosted by ${HOST_APP}.`
            : `Add or remove the open ${extension.siteName} streamer from the PC download list. Hosted by ${HOST_APP}.`,
        host_permissions: [...extension.matches, `${PC}:${filehost ? 9998 : 9999}/*`],
        background: { scripts: ['background.js'], service_worker: 'background.js', persistent: false },
        content_scripts: filehost ? [
            { matches: extension.matches.map(url => url.replace('/*', '/a/*')), js: ['content.js'], run_at: 'document_start', all_frames: false },
            { matches: extension.matches.map(url => url.replace('/*', '/f/*')), js: ['content.js'], run_at: 'document_end', all_frames: false },
        ] : [{ matches: extension.matches, js: ['content.js'], run_at: extension.runAt, all_frames: false }],
    }, null, 2) + '\n');
    console.log(`Built ${extension.name} into dist/extension/${key}`);
}
