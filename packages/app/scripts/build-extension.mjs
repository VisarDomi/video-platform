import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// XVideos keeps its background cookie worker; Porntrex's remember-me cookie needs none.
const EXTENSIONS = {
    xvideos: { name: 'Xvid', site: 'XVideos', hosts: ['xvideos.com', 'www.xvideos.com'], worker: true },
    porntrex: { name: 'Ptrex', site: 'Porntrex', hosts: ['porntrex.com', 'www.porntrex.com'], worker: false },
};
const args = process.argv.slice(2);
const extension = EXTENSIONS[args[0]];
if (args.length !== 1 || !extension) throw new Error(`Usage: npm run build:extension -- <${Object.keys(EXTENSIONS).join('|')}>`);
const build = spawnSync('npm', ['exec', '-w', 'app', '--', 'vite', 'build', '--mode', args[0]], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const out = resolve(root, 'dist/extension', args[0]);
const matches = extension.hosts.map(host => `https://${host}/*`);
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: extension.name, version: '1.0.0',
    description: `Video Platform for ${extension.site}, hosted by Tango.`,
    host_permissions: matches,
    ...(extension.worker ? {
        permissions: ['cookies', 'webRequest'],
        background: { scripts: ['content.js'], service_worker: 'content.js', persistent: false },
    } : {}),
    content_scripts: [{ matches, js: ['content.js'], run_at: 'document_start', world: 'MAIN', all_frames: false }]
}, null, 2) + '\n');
