// TEMPORARY (playback test): bundle the imported stream-viewer viewer as Tango's content
// script until the tango-live provider runs in the shared Video Platform viewer.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inline = { name: 'inline-css', setup(b) {
    b.onResolve({ filter: /\?inline$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -7)), namespace: 'inline' }));
    b.onLoad({ filter: /.*/, namespace: 'inline' }, async args => ({ contents: 'export default ' + JSON.stringify(await readFile(args.path, 'utf8')), loader: 'js' }));
} };
await build({ entryPoints: [resolve(app, '../tango/src/main.ts')], outfile: resolve(app, 'build/tango-live/content.js'),
    bundle: true, minify: true, format: 'iife', target: 'safari17', plugins: [inline], logLevel: 'warning' });
