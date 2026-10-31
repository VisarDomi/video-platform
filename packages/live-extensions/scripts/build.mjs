// Builds TsLive's LADDER/FMP4 list controls and FileHost-to-PC Safari extension.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = {
    'ladder-live': { name: 'LADDER live', site: 'LADDER', matches: ['https://ladder-live.example/*'], api: '/api/ladder' },
    'fmp4-live': { name: 'FMP4 live', site: 'Fmp4Live', matches: ['https://fmp4-live.example/*', 'https://*.fmp4-live.example/*'], api: '/api/fmp4' },
    'filehost': { name: 'FileHost to PC', site: 'FileHost', version: '1.0.1', matches: ['https://file-host.example/*', 'https://file-host.example/*', 'https://file-host.example/*'], api: '/api/filehost' },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXTENSIONS);
for (const key of names) {
    const extension = EXTENSIONS[key];
    if (!extension) throw new Error(`Usage: node scripts/build.mjs [${Object.keys(EXTENSIONS).join('|')}]`);
    const out = resolve(root, '../../dist/extension', key);
    await mkdir(out, { recursive: true });
    const common = { bundle: true, minify: true, format: 'iife', target: 'safari17', logLevel: 'warning', loader: { '.css': 'text' } };
    await build({ ...common, entryPoints: [resolve(root, 'src/extension', `${key}.ts`)], outfile: resolve(out, 'content.js') });
    await build({ ...common, entryPoints: [resolve(root, key === 'filehost' ? 'src/extension/filehost-background.ts' : 'src/extension/background.ts')], outfile: resolve(out, 'background.js'),
        define: { __API_PATH__: JSON.stringify(extension.api) } });
    await writeFile(resolve(out, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: extension.name, version: extension.version ?? '1.0.0',
        description: key === 'filehost' ? 'Send FileHost video downloads to your PC on the home network. Hosted by TsLive.' : `Add or remove the open ${extension.site} streamer from the PC download list. Hosted by TsLive.`,
        host_permissions: [...extension.matches, `https://192.168.1.197:${key === 'filehost' ? 9998 : 9999}/*`],
        background: { scripts: ['background.js'], service_worker: 'background.js', persistent: false },
        content_scripts: [{ matches: extension.matches, js: ['content.js'],
            run_at: key === 'ladder-live' ? 'document_start' : 'document_end', all_frames: false }],
    }, null, 2) + '\n');
    console.log(`Built ${extension.name} into dist/extension/${key}`);
}
