import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, cp, symlink, readdir, realpath, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Bounded offline test preparation. First-party emissions belong to this source owner.
const [sourceArg, outputArg] = process.argv.slice(2), source = resolve(sourceArg ?? ''), output = resolve(outputArg ?? '');
if (!sourceArg || !outputArg || process.argv.length !== 4 || output.startsWith(source + '/')) throw Error('online fixture paths refused');
try { await lstat(output); throw Error('online fixture output must be new'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const desktop = join(source, 'dsh-plugin-desktop'), provider = join(source, 'workdsh-web/packages/providers/enterprise-profile');
await mkdir(join(output, 'app', 'renderer'), {recursive:true});
for (const face of ['afos-local', 'afos-online']) await cp(join(desktop, 'renderer', face), join(output, 'app', 'renderer', face), {recursive:true});
const online = join(output, 'app/renderer/afos-online'), manifest = JSON.parse(await readFile(join(online, 'assets.json'), 'utf8'));
const boot = manifest.files.find(row=>row.file.startsWith('boot-') && row.file !== 'boot-0.js').file;
const original = await readFile(join(online, boot), 'utf8'), graph = JSON.parse(original.slice(original.indexOf('=')+1).replace(/;\s*$/, ''));
if(graph.entries.length!==23||!graph.entries.some(row=>row.id==='workdsh-plugin-enterprise-drafts')||graph.entries.some(row=>row.id.endsWith('drafts-local')))throw Error('real online graph required');
const observer=`window.__ModuleLoader__.load({id:'afos-online-test-observer',factory:()=>({name:'afos-online-test-observer',inject:['connection','sessions','layout','slots','uiWorkspace','uiSession','uiConversation','remote','remote.session'],apply(ctx){window.__AFOS_ONLINE_OBSERVER__=ctx;ctx.effect(()=>()=>{delete window.__AFOS_ONLINE_OBSERVER__});}})});`;
const row={id:'afos-online-test-observer',url:'/observer.js',rev:createHash('sha256').update(observer).digest('hex'),inject:[],external:[],immediately:true};
graph.entries.push(row);graph.batches.push({phase:'application',url:row.url,rev:row.rev,entries:[row.id]});
await writeFile(join(online,boot),'window["__DSH_BOOT__"]='+JSON.stringify(graph)+';');await writeFile(join(online,'observer.js'),observer);
const html=await readFile(join(online,'index.html'),'utf8');await writeFile(join(online,'index.html'),html.replace('</head>','<script src="/observer.js"></script></head>'));
const runtime = join(output, 'runtime'); await mkdir(join(runtime,'node_modules'),{recursive:true});
await writeFile(join(runtime,'package.json'),JSON.stringify({name:'afos-online-private-test-runtime',private:true,type:'module'})+'\n');
for(const entry of await readdir(join(provider,'node_modules'),{withFileTypes:true})){
 if(entry.name.startsWith('.'))continue;
 if(entry.name.startsWith('@')){await mkdir(join(runtime,'node_modules',entry.name),{recursive:true});for(const pkg of await readdir(join(provider,'node_modules',entry.name)))await symlink(await realpath(join(provider,'node_modules',entry.name,pkg)),join(runtime,'node_modules',entry.name,pkg),'dir');}
 else if(entry.name!=='workdsh-provider-enterprise-profile'&&entry.name!=='workdsh-plugin-enterprise-drafts')await symlink(await realpath(join(provider,'node_modules',entry.name)),join(runtime,'node_modules',entry.name),'dir');
}
await symlink(provider,join(runtime,'node_modules/workdsh-provider-enterprise-profile'),'dir');
await symlink(join(source,'workdsh-web/packages/plugins/enterprise-drafts'),join(runtime,'node_modules/workdsh-plugin-enterprise-drafts'),'dir');
const require=createRequire(join(source,'workdsh-web/packages/plugins/enterprise-drafts/package.json')),{build}=require('esbuild');
const cliRequire=createRequire(join(provider,'package.json'));
await symlink(dirname(cliRequire.resolve('@deepseek-ai/dsh/package.json')),join(runtime,'node_modules/@deepseek-ai/dsh'),'dir');
await build({entryPoints:[join(desktop,'scripts/enterprise-online-consumer.fixture.mts')],outfile:join(output,'run/main.mjs'),bundle:true,format:'esm',platform:'node',target:'node24',external:['electron'],packages:'external',sourcemap:true});
await build({entryPoints:[join(desktop,'src/enterprise-preload.ts')],outfile:join(output,'run/enterprise-preload.cjs'),bundle:true,format:'cjs',platform:'node',target:'node24',external:['electron']});
await mkdir(join(output,'run/node_modules/@afos'),{recursive:true});
await symlink(await realpath(join(source,'enterprise/plugin-agent-bridge/node_modules/@afos/model-adapter')),join(output,'run/node_modules/@afos/model-adapter'),'dir');
const receipt={source,output,runtime,app:join(output,'app'),main:join(output,'run/main.mjs'),originalModules:23,testObserverOnly:true,realOnlineExport:'./client',node:process.execPath,scope:'Linux offline component; no production capability or AT'};
await writeFile(join(output,'PREPARATION.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
