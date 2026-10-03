import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, copyFile, lstat, symlink, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Test preparation only. It emits into a new private fixture directory, never source/dependencies.
const [sourceArgument, outputArgument] = process.argv.slice(2);
if (!sourceArgument || !outputArgument || process.argv.length !== 4) throw Error('usage: prepare-enterprise-electron-consumer <source-root> <new-fixture-root>');
const source = resolve(sourceArgument), output = resolve(outputArgument);
if (output === source || output.startsWith(source + '/')) throw Error('fixture output must be outside the source tree');
try { await lstat(output); throw Error('fixture output must be new'); } catch(error) { if(error.code !== 'ENOENT') throw error; }
const desktop = join(source, 'dsh-plugin-desktop'), assets = join(desktop, 'renderer', 'afos-local');
const out = join(output, 'app', 'renderer', 'afos-local');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(assets, 'assets.json'), 'utf8'));
if(manifest.contractVersion !== 'afos.local-assets.v1' || !Array.isArray(manifest.files)) throw Error('invalid source asset manifest');
await mkdir(out, {recursive:true});
for(const row of manifest.files) {
 if(typeof row.file!=='string'||!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(row.file)||row.file.split('/').some(x=>x==='.'||x==='..'))throw Error('fixture asset path refused');
 const path=join(assets,row.file),stat=await lstat(path),bytes=await readFile(path);
 if(!stat.isFile()||stat.isSymbolicLink()||bytes.length!==row.bytes||digest(bytes)!==row.sha256)throw Error('fixture source asset refused');
 await mkdir(dirname(join(out,row.file)),{recursive:true});await copyFile(path,join(out,row.file));
}
const boot=manifest.files.find(row=>row.file.startsWith('boot-')&&row.file!=='boot-0.js').file;
const originalBoot=await readFile(join(out,boot),'utf8'),graph=JSON.parse(originalBoot.slice(originalBoot.indexOf('=')+1).replace(/;\s*$/,''));
const observer=`window.__ModuleLoader__.load({id:'afos-local-electron-observer',factory:()=>({name:'afos-local-electron-observer',inject:['connection','sessions','layout','slots','uiWorkspace','uiSession','uiConversation'],apply(ctx){window.__AFOS_LOCAL_OBSERVER__=ctx;ctx.effect(()=>()=>{delete window.__AFOS_LOCAL_OBSERVER__});}})});`;
const row={id:'afos-local-electron-observer',url:'/observer.js',rev:digest(observer),inject:[],external:[],immediately:true};
graph.entries.push(row);graph.batches.push({phase:'application',url:row.url,rev:row.rev,entries:[row.id]});
await writeFile(join(out,boot),'window["__DSH_BOOT__"]='+JSON.stringify(graph)+';');await writeFile(join(out,'observer.js'),observer);
const html=await readFile(join(out,'index.html'),'utf8');await writeFile(join(out,'index.html'),html.replace('</head>','<script src="/observer.js"></script></head>'));
const files=[];
for(const file of [...manifest.files.map(row=>row.file),'observer.js']) {
 const bytes=await readFile(join(out,file));files.push({file,bytes:bytes.length,sha256:digest(bytes),type:file==='observer.js'?'text/javascript':manifest.files.find(row=>row.file===file).type});
}
await writeFile(join(out,'assets.json'),JSON.stringify({contractVersion:'afos.local-assets.v1',files},null,2)+'\n');
const require=createRequire(join(source,'workdsh-web/packages/plugins/enterprise-drafts/package.json'));
const {build}=require('esbuild');const entry=join(desktop,'scripts/enterprise-electron-consumer.fixture.mts'),main=join(output,'run','main.mjs');
await build({entryPoints:[entry],outfile:main,bundle:true,format:'esm',platform:'node',target:'node24',external:['electron'],packages:'external',sourcemap:true});
// Preserve the original published package context (including package.json version reads).
const adapter=await realpath(join(source,'enterprise/plugin-agent-bridge/node_modules/@afos/model-adapter'));
await mkdir(join(output,'run','node_modules','@afos'),{recursive:true});
await symlink(adapter,join(output,'run','node_modules','@afos','model-adapter'),'dir');
const preload=await readFile(join(desktop,'lib/enterprise-preload.cjs'));
await writeFile(join(output,'run','enterprise-preload.cjs'),preload);
const receipt={source,output,app:join(output,'app'),main,modules:graph.entries.length,assets:files.length,originalModuleSystem:true,observerTestOnly:true,readonlyAdapterDependency:adapter,preloadSha256:digest(preload),profile:join(source,'workdsh-web/packages/providers/enterprise-profile'),scope:'Linux no-OS-sandbox fixture only; production capability refused'};
await writeFile(join(output,'PREPARATION.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
