// Builds Tango's FC2/SC list controls and Bunkr-to-PC Safari extension.
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = {
    'fc2-live': { name: 'FC2 live', site: 'FC2', matches: ['https://live.fc2.com/*'], api: '/api/fc2' },
    'sc-live': { name: 'SC live', site: 'Stripchat', matches: ['https://stripchat.com/*', 'https://*.stripchat.com/*'], api: '/api/sc' },
    'bunkr': { name: 'Bunkr to PC', site: 'Bunkr', version: '1.1.0', matches: ['https://bunkr.si/*', 'https://bunkr.ph/*', 'https://bunkr.cr/*'], api: '/api/bunkr' },
};
const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXTENSIONS);
for (const key of names) {
    const extension = EXTENSIONS[key];
    if (!extension) throw new Error(`Usage: node scripts/build.mjs [${Object.keys(EXTENSIONS).join('|')}]`);
    const out = resolve(root, '../../dist/extension', key);
    await mkdir(out, { recursive: true });
    const common = { bundle: true, minify: true, format: 'iife', target: 'safari17', logLevel: 'warning', loader: { '.css': 'text' } };
    await build({ ...common, entryPoints: [resolve(root, 'src/extension', `${key}.ts`)], outfile: resolve(out, 'content.js') });
    await build({ ...common, entryPoints: [resolve(root, key === 'bunkr' ? 'src/extension/bunkr-background.ts' : 'src/extension/background.ts')], outfile: resolve(out, 'background.js'),
        define: { __API_PATH__: JSON.stringify(extension.api) } });
    await writeFile(resolve(out, 'manifest.json'), JSON.stringify({
        manifest_version: 3, name: extension.name, version: extension.version ?? '1.0.0',
        description: key === 'bunkr' ? 'Send Bunkr video downloads to your PC on the home network. Hosted by Tango.' : `Add or remove the open ${extension.site} streamer from the PC download list. Hosted by Tango.`,
        host_permissions: [...extension.matches, `https://192.168.1.197:${key === 'bunkr' ? 9998 : 9999}/*`],
        background: { scripts: ['background.js'], service_worker: 'background.js', persistent: false },
        content_scripts: key === 'bunkr' ? [
            { matches: extension.matches.map(url => url.replace('/*', '/a/*')), js: ['content.js'], run_at: 'document_start', all_frames: false },
            { matches: extension.matches.map(url => url.replace('/*', '/f/*')), js: ['content.js'], run_at: 'document_end', all_frames: false },
        ] : [{ matches: extension.matches, js: ['content.js'], run_at: key === 'fc2-live' ? 'document_start' : 'document_end', all_frames: false }],
    }, null, 2) + '\n');
    console.log(`Built ${extension.name} into dist/extension/${key}`);
}
