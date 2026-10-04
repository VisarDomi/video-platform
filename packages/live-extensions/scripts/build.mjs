// Builds the LADDER live and FMP4 live Safari extensions (hosted by the TsLive app).
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = {
    'ladder-live': { name: 'LADDER live', site: 'LADDER', matches: ['https://ladder-live.example/*'], api: '/api/ladder' },
    'fmp4-live': { name: 'FMP4 live', site: 'Fmp4Live', matches: ['https://fmp4-live.example/*', 'https://*.fmp4-live.example/*'], api: '/api/fmp4' },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXTENSIONS);
for (const key of names) {
    const extension = EXTENSIONS[key];
    if (!extension) throw new Error(`Usage: node scripts/build.mjs [${Object.keys(EXTENSIONS).join('|')}]`);
    const out = resolve(root, '../../dist/extension', key);
    await mkdir(out, { recursive: true });
    const common = { bundle: true, minify: true, format: 'iife', target: 'safari17', logLevel: 'warning', loader: { '.css': 'text' } };
    await build({ ...common, entryPoints: [resolve(root, 'src/extension', `${key}.ts`)], outfile: resolve(out, 'content.js') });
    await build({ ...common, entryPoints: [resolve(root, 'src/extension/background.ts')], outfile: resolve(out, 'background.js'),
        define: { __API_PATH__: JSON.stringify(extension.api) } });
    await writeFile(resolve(out, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: extension.name, version: '1.0.0',
        description: `Add or remove the open ${extension.site} streamer from the PC download list. Hosted by TsLive.`,
        host_permissions: extension.matches,
        background: { scripts: ['background.js'], service_worker: 'background.js', persistent: false },
        content_scripts: [{ matches: extension.matches, js: ['content.js'], run_at: 'document_end', all_frames: false }],
    }, null, 2) + '\n');
    console.log(`Built ${extension.name} into dist/extension/${key}`);
}
