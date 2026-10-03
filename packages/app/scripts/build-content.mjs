import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The online apps (Xvid, Ptrex, Tango) each inject one provider's content script.
const PROVIDERS = ['xvideos', 'porntrex', 'tango-live'];
const args = process.argv.slice(2);
if (args.length !== 1 || !PROVIDERS.includes(args[0])) throw new Error(`Usage: npm run build:content -- <${PROVIDERS.join('|')}>`);
const build = spawnSync('npm', ['exec', '-w', 'app', '--', 'vite', 'build', '--mode', args[0]], { cwd: root, stdio: 'inherit' });
process.exit(build.status ?? 1);
