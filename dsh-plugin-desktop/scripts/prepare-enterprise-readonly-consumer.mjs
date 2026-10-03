import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const [sourceArg, outputArg]=process.argv.slice(2);
if(!sourceArg||!outputArg||process.argv.length!==4)throw Error('readonly original23 fixture paths');
const source=resolve(sourceArg),output=resolve(outputArg),desktop=join(source,'dsh-plugin-desktop');
// Reuse the frozen original 23-module online graph preparation and private CLI runtime.
execFileSync(process.execPath,[join(desktop,'scripts/prepare-enterprise-online-consumer.mjs'),source,output],{stdio:'inherit'});
const online=join(output,'app/renderer/afos-online'),observerPath=join(online,'observer.js');
const observer=(await readFile(observerPath,'utf8')).replace("'remote.session']","'remote.session','remote.workspace','remote.settings']");
await writeFile(observerPath,observer);
const assets=JSON.parse(await readFile(join(online,'assets.json'),'utf8'));
const boot=assets.files.find(row=>row.file.startsWith('boot-')&&row.file!=='boot-0.js').file,bootPath=join(online,boot),bootSource=await readFile(bootPath,'utf8');
const graph=JSON.parse(bootSource.slice(bootSource.indexOf('=')+1).replace(/;\s*$/,'')),revision=createHash('sha256').update(observer).digest('hex');
graph.entries.find(row=>row.id==='afos-online-test-observer').rev=revision;
graph.batches.find(row=>row.entries.includes('afos-online-test-observer')).rev=revision;
await writeFile(bootPath,'window["__DSH_BOOT__"]='+JSON.stringify(graph)+';');
const entry=join(desktop,'scripts/enterprise-online-consumer.fixture.mts'),original=await readFile(entry,'utf8');
let contents=original;
const replace=(from,to)=>{if(contents.split(from).length!==2)throw Error('original online fixture drift');contents=contents.replace(from,to);};
replace("assert.equal(coldList.ok,false);","assert.equal(coldList.ok,true);assert.deepEqual(coldList.value.items,[]);");
replace('coldListRefused:true','coldListReadOnlyEmpty:true');
const marker=" if(process.env.AFOS_ONLINE_CLOSE_ONLY==='1'){";
replace(marker,`
 const catalog=await ui(\`(async()=>{const ctx=window.__AFOS_ONLINE_OBSERVER__,out={};out.list=await ctx.remote.session.list({});const settings=await ctx.remote.settings.describe();out.settings={ok:settings.ok,code:settings.error?.code};for(const [key,stream] of [['workspace',signal=>ctx.remote.workspace.follow(signal)],['control',signal=>ctx.remote.session.control(signal)]]){const abort=new AbortController(),it=stream(abort.signal)[Symbol.asyncIterator]();try{out[key]=(await it.next()).value;}finally{abort.abort();await it.return();}}for(const endpoint of ['workspace/initializeDefault','session/create','session/prompt','settings/write']){try{const value=await ctx.connection.rpc.call('/api',endpoint,{args:{}});out[endpoint]=value?.ok===false;}catch{out[endpoint]=true;}}return out;})()\`);
 assert.equal(catalog.list.ok,true);assert.deepEqual(catalog.list.value.items,[]);assert.equal(catalog.workspace.type,'baseline');assert.deepEqual(catalog.workspace.value,{items:[],archivedSessionIds:[],pinnedSessionIds:[]});assert.deepEqual(catalog.control,{type:'baseline',value:{projections:{}}});assert.equal(catalog.settings.ok,false);assert.equal(catalog.settings.code,'gateway/internal');
 for(const endpoint of ['workspace/initializeDefault','session/create','session/prompt','settings/write'])assert.equal(catalog[endpoint],true,endpoint);
 assert.equal(modelCalls,0);assert.equal(f.tables.runs.size,0);results.push({case:'original23-physical-readonly-catalog',pass:true,catalog,zeroRuns:true,zeroModelCalls:true,settingsProviderGap:true,coldRetainFollowUnavailable:true});
${marker}`);
replace(" if(process.env.AFOS_ONLINE_CLOSE_ONLY==='1'){"," if(process.env.AFOS_ONLINE_CLOSE_ONLY==='1'||process.env.AFOS_ONLINE_CATALOG_ONLY==='1'){");
replace("results:[{case:'online-real-window-close-sync-permit-cutoff',pass:true,physicalPermits:permits.length}],networkFacts", "results,windowClose:{pass:true,physicalPermits:permits.length},networkFacts,consoleFacts,bootstrapFacts");
const {build}=createRequire(join(source,'workdsh-web/packages/plugins/enterprise-drafts/package.json'))('esbuild');
await build({entryPoints:[entry],outfile:join(output,'run/main.mjs'),bundle:true,format:'esm',platform:'node',target:'node24',external:['electron'],packages:'external',sourcemap:true,
 plugins:[{name:'bounded-readonly-original23-fixture',setup(builder){builder.onLoad({filter:/enterprise-online-consumer\.fixture\.mts$/},args=>({contents,loader:'ts',resolveDir:dirname(args.path)}));}}]});
await writeFile(join(output,'READONLY_PREPARATION.json'),JSON.stringify({source,output,originalFixture:entry,
 originalSha256:createHash('sha256').update(original).digest('hex'),transformedSha256:createHash('sha256').update(contents).digest('hex'),
 changes:'cold list empty success; exact original public SDK four-method observation; original writes refused; bounded catalog-only close preserves all privacy checks',
 originalModules:23,scope:'actual offline Electron/private original CLI/read catalog; no full GUI/cold-retained follow/production AT'},null,2)+'\n');
console.log(JSON.stringify({output,originalModules:23,readonlyCatalogFixture:true}));
