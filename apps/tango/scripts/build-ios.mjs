import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), app=resolve(root,'apps/ios');
const registry=JSON.parse(await readFile(resolve(root,'src/provider/providers.json'),'utf8'));
const args=process.argv.slice(2), keys=args.filter(arg=>arg!=='--prepare-only');
if(keys.length!==1 || args.some(arg=>arg.startsWith('--') && arg!=='--prepare-only') || !registry[keys[0]]?.ios)
    throw new Error('Usage: npm run build:ios -- tango [--prepare-only]. A single supported provider is required.');
const key=keys[0], config=registry[key].ios, out=resolve(app,'build',key,'Web');
await mkdir(out,{recursive:true});
const plugin={name:'native-platform',setup(b) {
    b.onResolve({filter:/^@selected-provider$/},()=>({path:key,namespace:'provider'}));
    b.onLoad({filter:/.*/,namespace:'provider'},()=>({contents:`import {${key}} from '${resolve(root,'src/provider',key,'provider.ts')}';
        import {native} from '${resolve(app,'web/native.ts')}';
        export const provider={...${key}, startAuthentication:()=>native('authenticate'), resolvePlayback:stream=>native('media',{url:stream.masterListUrl})};`,loader:'ts',resolveDir:root}));
    b.onResolve({filter:/./},args=>{
        const path=resolve(args.resolveDir,args.path);
        if(path===resolve(root,'src/provider')) return {path:resolve(root,'src/provider/types.ts')};
        if(path===resolve(root,'src/core/request')) return {path:resolve(app,'web/request.ts')};
        if(path===resolve(root,'src/core/state') && args.importer!==resolve(app,'web/state.ts')) return {path:resolve(app,'web/state.ts')};
        // Preserve the shared status renderer; replace only document takeover.
        if(path===resolve(root,'src/core/page') && args.importer!==resolve(app,'web/page.ts')) return {path:resolve(app,'web/page.ts')};
        if(args.path.endsWith('?inline')) return {path:resolve(args.resolveDir,args.path.slice(0,-7)),namespace:'inline'};
    });
    b.onLoad({filter:/.*/,namespace:'inline'},async args=>({contents:'export default '+JSON.stringify(await readFile(args.path,'utf8')),loader:'js'}));
}};
const result=await build({entryPoints:[resolve(app,'web/app.ts')],outfile:resolve(out,'app.js'),bundle:true,minify:true,format:'iife',target:'safari17',metafile:true,plugins:[plugin]});
await writeFile(resolve(out,'index.html'),await readFile(resolve(app,'web/index.html')));
await writeFile(resolve(app,'build',key,'inputs.json'),JSON.stringify(Object.keys(result.metafile.inputs),null,2)+'\n');
await writeFile(resolve(app,'build/providers.json'),JSON.stringify(Object.fromEntries(Object.entries(registry).filter(([,v])=>v.ios).map(([k,v])=>[k,v.ios])),null,2)+'\n');
if(config.extensions?.includes('Xvid')) {
    const extension=spawnSync(process.execPath,[resolve(root,'scripts/build-extension.mjs')],{cwd:root,stdio:'inherit'});
    if(extension.status!==0) process.exit(extension.status??1);
    const source=resolve(root,'dist/extension'), destination=resolve(app,'build',key,'Xvid');
    const manifest=JSON.parse(await readFile(resolve(source,'manifest.json'),'utf8'));
    const matches=['https://xvideos.com/*','https://www.xvideos.com/*'];
    manifest.name='Xvid';
    manifest.description='Stream Viewer for XVideos, hosted by Tango.';
    manifest.host_permissions=matches;
    for(const content of manifest.content_scripts) content.matches=matches;
    await mkdir(destination,{recursive:true});
    await copyFile(resolve(source,'content.js'),resolve(destination,'content.js'));
    await writeFile(resolve(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    console.log('Packaged Xvid from this repository’s shared extension source.');
}
const generated=spawnSync('python3',[resolve(app,'scripts/project.py'),key],{stdio:'inherit'});
if(generated.status!==0) process.exit(generated.status??1);
console.log(`Prepared ${config.name} with the shared Stream Viewer UI.`);
if(!args.includes('--prepare-only')) {
    if(process.platform!=='darwin') throw new Error('Build/sign on the documented Mac; use --prepare-only on Linux.');
    process.exit(spawnSync('python3',[resolve(app,'scripts/build-native.py'),key],{stdio:'inherit'}).status??1);
}
