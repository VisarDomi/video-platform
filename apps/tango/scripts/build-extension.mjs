import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

execFileSync('npx', ['vite', 'build', '--mode', 'extension'], { stdio: 'inherit' });
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const matches = ['https://tango.me/*', 'https://www.tango.me/*'];
writeFileSync('dist/extension/manifest.json', JSON.stringify({
    manifest_version: 3,
    name: 'Stream Viewer',
    version,
    description: 'Stream Viewer for Tango, using the existing site session.',
    host_permissions: matches,
    content_scripts: [{ matches, js: ['content.js'], run_at: 'document_start', world: 'MAIN', all_frames: false }],
}, null, 2) + '\n');
console.log('Stream Viewer extension built: dist/extension');
