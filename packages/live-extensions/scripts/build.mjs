// Builds the FC2 live and SC live Safari extensions (hosted by the Tango app).
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = {
    'fc2-live': { name: 'FC2 live', site: 'FC2', matches: ['https://live.fc2.com/*'], api: '/api/fc2' },
    'sc-live': { name: 'SC live', site: 'Stripchat', matches: ['https://stripchat.com/*', 'https://*.stripchat.com/*'], api: '/api/sc' },
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
        description: `Add or remove the open ${extension.site} streamer from the PC download list. Hosted by Tango.`,
        host_permissions: extension.matches,
        background: { scripts: ['background.js'], service_worker: 'background.js', persistent: false },
        content_scripts: [{ matches: extension.matches, js: ['content.js'], run_at: 'document_end', all_frames: false }],
    }, null, 2) + '\n');
    console.log(`Built ${extension.name} into dist/extension/${key}`);
}
