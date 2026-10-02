import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== 'xvideos') throw new Error('Usage: npm run build:extension -- xvideos');
const build = spawnSync('npm', ['exec', '-w', 'app', '--', 'vite', 'build', '--mode', args[0]], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const out = resolve(root, 'dist/extension/xvideos');
const matches = ['https://xvideos.com/*', 'https://www.xvideos.com/*'];
writeFileSync(resolve(out, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Xvid', version: '1.0.0',
    description: 'Video Platform for XVideos, hosted by Tango.',
    host_permissions: matches, permissions: ['cookies', 'webRequest'],
    background: { scripts: ['content.js'], service_worker: 'content.js', persistent: false },
    content_scripts: [{ matches, js: ['content.js'], run_at: 'document_start', world: 'MAIN', all_frames: false }]
}, null, 2) + '\n');
