import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

execFileSync('npx', ['vite', 'build', '--mode', 'extension'], { stdio: 'inherit' });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const matches = ['https://tango.me/*', 'https://www.tango.me/*', 'https://xvideos.com/*', 'https://www.xvideos.com/*'];
writeFileSync('dist/extension/manifest.json', JSON.stringify({
    manifest_version: 3,
    name: 'Stream Viewer',
    version,
    description: 'Tango live streams and XVideos uploads, using the existing site sessions.',
    host_permissions: matches,
    permissions: ['cookies', 'webRequest'],
    background: { scripts: ['content.js'], service_worker: 'content.js', persistent: false },
    content_scripts: [{ matches, js: ['content.js'], run_at: 'document_start', world: 'MAIN', all_frames: false }],
}, null, 2) + '\n');
console.log('Stream Viewer extension built: dist/extension');
