import { app, BrowserWindow, ipcMain, protocol, net } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from '../../enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs';
import { createEnterpriseLocalWindow } from '../src/enterprise-window.ts';
import { runtimeDraftProjection } from '../src/enterprise-electron.ts';
import { EnterpriseCliHost, type EnterpriseCliReady } from '../src/enterprise-cli-host.ts';
import { redactRuntimeLog } from '../src/runtime-security.ts';
import { bootstrapEnterpriseOnline } from '../src/enterprise-online-window.ts';

const output=process.env.AFOS_ONLINE_OUTPUT!, assets=process.env.AFOS_ONLINE_APP!, runtime=process.env.AFOS_ONLINE_RUNTIME!, node=process.env.AFOS_ONLINE_NODE!;
if(!output||!assets||!runtime||!node)throw Error('private online fixture paths required');
app.on('window-all-closed',()=>{});app.disableHardwareAcceleration();app.setPath('userData',join(output,'userdata'));app.setPath('crashDumps',join(output,'crash'));
protocol.registerSchemesAsPrivileged([{scheme:'afos-local',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const results:any[]=[], consoleFacts:any[]=[], networkFacts:any[]=[], bootstrapFacts:any[]=[];
const permits:AbortSignal[]=[], fixtureStart=Date.now();
const secrets=new Set<string>();
function safeLog(value:string):string{let text=redactRuntimeLog(value);for(const secret of secrets)if(text.includes(secret))text=text.replaceAll(secret,'[PRIVATE_RUNTIME_VALUE]');return text.replace(/127\.0\.0\.1:[0-9]+/g,'127.0.0.1:PORT');}
let face:ReturnType<typeof createEnterpriseLocalWindow>|undefined, f:Awaited<ReturnType<typeof fixture>>|undefined, host:EnterpriseCliHost|undefined, foreign:BrowserWindow|undefined;
let privateReady:EnterpriseCliReady|undefined, pause=false, entered:()=>void=()=>{}, release:()=>void=()=>{};
let modelCalls=0;
const toolReply=(name:string,args:unknown)=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:'call-'+name,name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id:'call-'+name,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
const timer=setTimeout(()=>{console.error('online bounded fixture timeout');app.exit(1)},115000);
const ui=(code:string)=>face!.window.webContents.executeJavaScript(code,true);
async function until(code:string,label:string){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await ui(code))return;await new Promise(r=>setTimeout(r,50));}throw Error('online condition failed: '+label);}
const unary=(method:string,payload:unknown={})=>ui(`window.__AFOS_ONLINE_OBSERVER__.connection.rpc.call('/api',${JSON.stringify(method)},${JSON.stringify(payload)})`);
void(async()=>{try{
 await app.whenReady();await mkdir(output,{recursive:true});
 f=await fixture({stopHost:async()=>host?.stop(),response:async(request:any)=>{if(pause&&request.action==='identity.current'){entered();await new Promise<void>(r=>release=r);}return undefined;},model:async()=>{modelCalls++;return modelCalls===1?toolReply('afos_read_snapshot',{materialId:f!.ref.materialId,revisionId:f!.ref.revisionId}):modelCalls===2?toolReply('afos_render_draft',{text:'Owned original online draft.',sources:[f!.ref]}):[{type:'finish',reason:{kind:'stop'}}];}});
 await f.ready();
 face=createEnterpriseLocalWindow({createWindow:options=>new BrowserWindow({...options,show:false}),ipc:ipcMain,appPath:assets,capabilities:()=>f!.main.localDraftCapabilities(),projectDraft:runtimeDraftProjection(runtime),closed(){},loadFailed(){}});
 await face.ready;
 face.window.webContents.on('console-message',(_event:any,level:any,message:any)=>{const text=typeof level==='object'?level.message:message;consoleFacts.push({message:safeLog(String(text))});});
 // Main test observation stores paths/facts only, never headers, token URLs or cookies.
 face.window.webContents.session.webRequest.onSendHeaders(details=>networkFacts.push({timeMs:Date.now()-fixtureStart,method:details.method,path:new URL(details.url).pathname,type:details.resourceType,contents:details.webContentsId,frameTop:!!details.frame&&details.frame===face!.window.webContents.mainFrame,witness:Object.keys(details.requestHeaders).some(k=>k.toLowerCase()==='x-afos-native-witness')}));
 host=new EnterpriseCliHost({executable:node,runtimeProfile:runtime,model:{provider:'afos-managed',model:'fixed-model',maxTokens:64},callerIssuer:{assertRequest:async(request,signal)=>{secrets.add(request.witness);const permit=await face!.online.callerIssuer.assertRequest(request,signal);permits.push(permit.signal);return permit;}},writeLog:text=>consoleFacts.push({cli:safeLog(text)}),
  online:{frontendIndex:join(assets,'renderer/afos-online/index.html'),onReady:async ready=>{privateReady=ready;secrets.add(ready.authenticatedUrl);secrets.add(new URL(ready.authenticatedUrl).searchParams.get('token')!);
   let response;try{response=await face!.window.webContents.session.fetch(ready.authenticatedUrl,{redirect:'manual',credentials:'include',signal:ready.signal});}catch(error){bootstrapFacts.push({fetchError:redactRuntimeLog(String(error))});}
   const cookies=await face!.window.webContents.session.cookies.get({url:`http://127.0.0.1:${ready.port}/`});
   for(const cookie of cookies)secrets.add(cookie.value);
   bootstrapFacts.push({status:response?.status,type:response?.type,location:response?.headers.get('location'),hasSetCookie:!!response?.headers.get('set-cookie'),cookies:cookies.map(c=>({hostOnly:c.hostOnly,domain:c.domain,path:c.path,httpOnly:c.httpOnly,secure:c.secure,sameSite:c.sameSite,session:c.session,expirationDate:c.expirationDate}))});
   await new Promise<void>((resolve,reject)=>{const request=net.request({url:ready.authenticatedUrl,session:face!.window.webContents.session,redirect:'manual',useSessionCookies:true});request.on('redirect',(status,method,url,headers)=>{const raw=headers['set-cookie'],value=Array.isArray(raw)?raw[0]:raw;bootstrapFacts.push({netStatus:status,method,cleanRedirect:url===`http://127.0.0.1:${ready.port}/`,cookieHeaderType:typeof raw,cookieHeaderCount:Array.isArray(raw)?raw.length:0,cookieAttrs:typeof value==='string'?value.split(';').slice(1):[]});request.abort();resolve();});request.on('error',reject);request.end();});
   try{await bootstrapEnterpriseOnline(face!.window.webContents.session,ready);}catch(error){bootstrapFacts.push({bootstrapStage:(error as any).stage});throw error;}
   for(const cookie of await face!.window.webContents.session.cookies.get({url:`http://127.0.0.1:${ready.port}/`}))secrets.add(cookie.value);
   await face!.online.showOnline(ready,f!.main.localDraftCapabilities().accountSignal);}},onUnexpectedStop:async()=>f!.main.stopEnterprise()});
 assert.deepEqual(await host.capabilities(),{ingressValidated:false,sandbox:'unavailable'});
 f.startHook((signal:any,layout:any,authority:any,business:any)=>host!.start(layout,authority,signal,business));
 f.capability({ingressValidated:true,sandbox:'full'}); // Fixture only; product gate remains false/unavailable.
 await f.main.startHost();assert.ok(privateReady&&privateReady.port>0);assert.notEqual(host.processId(),process.pid);
 await until('!!window.__AFOS_ONLINE_OBSERVER__?.connection.generation.getSnapshot()','original cold ready');
 const first=await ui(`({url:location.href,node:typeof require,local:typeof window.afosLocalDrafts,transport:typeof window.__DSH_TRANSPORT__,original:window.__DSH_BOOT__.entries.filter(x=>x.id!=='afos-online-test-observer').length,modules:[...window.__AFOS_ONLINE_OBSERVER__.loader.entries()].map(x=>({id:x.options.name,state:x.fiber?.state,error:x.fiber?.error?.message}))})`);
 assert.equal(first.url,`http://127.0.0.1:${privateReady!.port}/`);assert.equal(first.node,'undefined');assert.equal(first.local,'undefined');assert.equal(first.original,23);assert.equal(first.modules.filter((x:any)=>x.state===2).length,24);
 await ui("window.__AFOS_ONLINE_OBSERVER__.layout.selectPanel('afos-enterprise-drafts')");
 assert.equal(face.window.webContents.session.isPersistent(),false);const cookies=await face.window.webContents.session.cookies.get({url:first.url});assert.equal(cookies.length,1);assert.equal(cookies[0]!.httpOnly,true);assert.equal(cookies[0]!.sameSite,'strict');
 assert.equal(await ui("document.cookie.includes('dsh-auth-')"),false);
 const state=await unary('afos/drafts/state');assert.equal(state.ok,true);assert.equal(state.value.drafts.length,0);
 const materials=await unary('afos/drafts/materials');assert.equal(materials.ok,true);assert.equal(materials.value.length,1);
 const coldList=await unary('session/list',{args:{_request:{}}});assert.equal(coldList.ok,false);
 results.push({case:'online-original-cli-private-ready-cookie23-cold',pass:true,portZeroCommitted:true,originalIndex303CookiePersisted:true,ephemeralSession:true,originalModules:23,coldListRefused:true,productionCaps:false});
 if(process.env.AFOS_ONLINE_CLOSE_ONLY==='1'){
  assert.ok(permits.some(s=>!s.aborted));face.window.destroy();assert.ok(permits.every(s=>s.aborted));face=undefined;await f.cleanup();f=undefined;
  const sink=JSON.stringify({results,networkFacts,consoleFacts,bootstrapFacts});for(const secret of secrets)assert.equal(sink.includes(secret),false);
  await writeFile(join(output,'result.json'),JSON.stringify({scope:'actual originalCLI/Electron owned-window close component; not AT',results:[{case:'online-real-window-close-sync-permit-cutoff',pass:true,physicalPermits:permits.length}],networkFacts,secretCheck:{valuesChecked:secrets.size,noValuesInSink:true,valuesPersisted:false}},null,2)+'\n');clearTimeout(timer);app.exit(0);return;
 }
 // No browser-visible witness/header/Node/auth token; original Connection rejects missing auth and cross-Origin before Main.
 const authority=new URL(first.url).host,before=f.calls.length;
 const without=await fetch(first.url+'api/afos/drafts/state',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:'no-auth',method:'afos/drafts/state',payload:{}})});assert.equal(without.status,401);await without.arrayBuffer();assert.equal(f.calls.length,before);
 const cross=await fetch(first.url+'api/afos/drafts/state',{method:'POST',headers:{cookie:cookies[0]!.name+'='+cookies[0]!.value,origin:'afos-local://drafts','content-type':'application/json','x-afos-native-witness':'A'.repeat(43)},body:JSON.stringify({type:'client-request',rpcId:'cross-origin',method:'afos/drafts/state',payload:{}})});assert.equal(cross.status,403);await cross.arrayBuffer();assert.equal(f.calls.length,before);
 assert.equal(await ui(`fetch('/api/afos/drafts/state',{method:'POST',headers:{'x-afos-native-witness':'${'A'.repeat(43)}'},body:'{}'}).then(()=>false,()=>true)`),true);
 const frame=await ui(`new Promise(resolve=>{const e=document.createElement('iframe');e.src='/';e.onload=()=>{e.contentWindow.fetch('/api/afos/drafts/state',{method:'POST',body:'{}'}).then(()=>resolve(false),()=>resolve(true))};document.body.append(e);})`);assert.equal(frame,true);
 foreign=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,session:face.window.webContents.session}});await foreign.loadURL(first.url);assert.equal(await foreign.webContents.executeJavaScript("fetch('/api/afos/drafts/state',{method:'POST',body:'{}'}).then(()=>false,()=>true)"),true);foreign.destroy();foreign=undefined;
 results.push({case:'online-physical-http-frame-and-window',pass:true,noAuthConnection401:true,originalCookieCrossOrigin403:true,forgedWitnessBlocked:true,iframeRefused:true,foreignWindowRefused:true,authority:authority.replace(/:[0-9]+$/,':PORT')});
 const started=await unary('afos/drafts/start',{sources:[f.ref],goal:'Use original online Conversation.',operationId:'electron-online-owner'});assert.equal(started.ok,true);
 await until("document.body.innerText.includes('Owned original online draft.')","online finite panel draft");
 const list=await unary('session/list',{args:{_request:{}}});assert.equal(list.ok,true);assert.ok(JSON.stringify(list).includes(started.value.sessionId));assert.equal(modelCalls,3);
 const seam=await ui(`(async()=>{const ctx=window.__AFOS_ONLINE_OBSERVER__,s=${JSON.stringify(started.value.sessionId)},abort=new AbortController(),it=ctx.remote.session.follow({address:{kind:'session',sessionId:s},assistantStream:true,maxMessages:500},abort.signal)[Symbol.asyncIterator]();try{const value=await it.next();return {type:value.value?.type,id:value.value?.header?.id}}finally{abort.abort();await it.return()}})()`);assert.equal(seam.type,'snapshot');assert.equal(seam.id,started.value.sessionId);
 await ui("[...document.querySelectorAll('button')].find(x=>x.textContent==='打开原生会话').click()");
 await new Promise(r=>setTimeout(r,1200));const navigation=await ui("({originalConversationSelected:!document.querySelector('#afos-draft-goal'),body:document.body.innerText})");
 await ui("window.__AFOS_ONLINE_OBSERVER__.layout.selectPanel('afos-enterprise-drafts')");
 const gaps=await ui(`(async()=>{const ctx=window.__AFOS_ONLINE_OBSERVER__,s=${JSON.stringify(started.value.sessionId)},out={};for(const [key,endpoint,payload] of [['settings','settings/describe',{}],['prompt','session/prompt',{sessionId:s,message:'unauthorized'}]]){try{out[key]=await ctx.connection.rpc.call('/api',endpoint,payload)}catch{out[key]='refused'}}for(const key of ['workspace','control']){const abort=new AbortController();try{const it=(key==='workspace'?ctx.remote.workspace.follow(abort.signal):ctx.remote.session.control(abort.signal))[Symbol.asyncIterator]();out[key]=await it.next()}catch{out[key]='refused'}finally{abort.abort()}}return out})()`);
 results.push({case:'online-owned-original-session-conversation-seam',pass:true,oneRun:f.tables.runs.size,modelCalls,ownedFollow:seam,navigation,gaps});assert.equal(f.tables.runs.size,1);assert.equal(f.tables.artifacts.size,0);
 // A real same-URL reload cuts pending old-document work before noncooperative authority returns.
 pause=true;const called=new Promise<void>(r=>entered=r);void ui("window.__AFOS_ONLINE_OBSERVER__.connection.rpc.call('/api','afos/drafts/state',{})").catch(()=>{});await called;
 const reloaded=new Promise<void>(r=>face!.window.webContents.once('did-finish-load',()=>r()));face.window.webContents.reload();await reloaded;pause=false;release();
 await until('!!window.__AFOS_ONLINE_OBSERVER__?.connection.generation.getSnapshot()','reload fresh SDK');assert.equal((await unary('afos/drafts/state')).ok,true);assert.equal(f.tables.runs.size,1);
 results.push({case:'online-real-same-url-reload-late',pass:true,freshDocument:true,oneRun:true});
 const ownedMux=()=>networkFacts.filter(x=>x.path==='/api/remote.mux'&&x.witness&&x.frameTop).length,muxBefore=ownedMux(),longStart=Date.now();await new Promise(r=>setTimeout(r,62000));await until('!!window.__AFOS_ONLINE_OBSERVER__?.connection.generation.getSnapshot()','fresh SDK reconnect after caller60s');assert.equal((await unary('afos/drafts/state')).ok,true);assert.equal((await unary('session/list',{args:{_request:{}}})).ok,true);assert.equal(f.tables.runs.size,1);assert.ok(ownedMux()>muxBefore,'real Session hook must issue fresh mux witness after SDK reconnect');
 results.push({case:'online-real-sdk-fresh-reconnect60s',pass:true,elapsedMs:Date.now()-longStart,callerTTLUnchanged:60000,muxBefore,muxAfter:ownedMux(),oneRun:true});
 const crashedReady=privateReady!;process.kill(host.processId()!,'SIGKILL');await until("location.href==='afos-local://drafts/index.html'","Host crash restores local face");assert.equal(crashedReady.signal.aborted,true);
 const stopDeadline=Date.now()+6000;while(host.processId()!==undefined&&Date.now()<stopDeadline)await new Promise(r=>setTimeout(r,25));assert.equal(host.processId(),undefined);
 await f.main.startHost();await until('!!window.__AFOS_ONLINE_OBSERVER__?.connection.generation.getSnapshot()','new cold CLI after crash');assert.notEqual(privateReady,crashedReady);
 await assert.rejects(face.online.showOnline(crashedReady,f.main.localDraftCapabilities().accountSignal));assert.ok(face.window.webContents.getURL().startsWith('http://127.0.0.1:'));assert.equal((await unary('afos/drafts/state')).ok,true);assert.equal((await unary('session/list',{args:{_request:{}}})).ok,false,'cold original process has no live Agent; durable cold history is a separate gap');
 results.push({case:'online-real-host-crash-restart-late-ready',pass:true,localFaceOnCrash:true,newColdCLI:true,oldReadyRefused:true,coldHistoryGap:true});
 const rendererReady=privateReady!,rendererGone=new Promise<void>(r=>face!.window.webContents.once('render-process-gone',()=>r()));face.window.webContents.forcefullyCrashRenderer();await rendererGone;assert.ok(permits.every(s=>s.aborted));await until("location.href==='afos-local://drafts/index.html'","Renderer crash restores local face");await assert.rejects(face.online.showOnline(rendererReady,f.main.localDraftCapabilities().accountSignal));
 results.push({case:'online-real-renderer-crash-sync-permit-cutoff',pass:true,localFace:true,consumedReadyRefused:true});
 await f.main.selectProject('p1');face.owner.changed();await until("location.href==='afos-local://drafts/index.html'","account replacement restores local face");assert.equal(privateReady!.signal.aborted,true);
 await assert.rejects(face.online.showOnline(privateReady!,f.main.localDraftCapabilities().accountSignal));assert.equal(face.window.webContents.getURL(),'afos-local://drafts/index.html');
 results.push({case:'online-account-cutoff-no-late-ready-revival',pass:true,localFace:true});
 await assert.rejects(f.main.startHost(),/enterprise\/cli-host-refused/);await until("location.href==='afos-local://drafts/index.html'","detached mainFrame stays local and refuses online startup");assert.equal(host.processId(),undefined);
 results.push({case:'online-detached-mainframe-post-crash-start-refused',pass:true,localFace:true,scope:'Electron forcefullyCrashRenderer leaves detached mainFrame in this fixture; recovery requires fresh owned window facts, never relaxed frame checks'});
 face.window.destroy();face=undefined;
 await f.cleanup();f=undefined;
 assert.ok(networkFacts.some(x=>x.path==='/api/remote.mux'&&x.witness&&x.frameTop));assert.ok(networkFacts.some(x=>x.path==='/api/afos/drafts/state'&&x.witness&&x.frameTop));
 const sink=JSON.stringify({results,networkFacts,consoleFacts,bootstrapFacts});for(const secret of secrets)assert.equal(sink.includes(secret),false);
 await writeFile(join(output,'result.json'),JSON.stringify({scope:'actual original CLI/Electron43 --no-sandbox offline component; not target AT',results,networkFacts,consoleFacts,bootstrapFacts,secretCheck:{valuesChecked:secrets.size,noValuesInSink:true,valuesPersisted:false}},null,2)+'\n');console.log(JSON.stringify({pass:results.length,cases:results.map(x=>x.case)}));clearTimeout(timer);app.exit(0);
}catch(error){let page;try{page=await ui('({text:document.body.innerText,observer:!!window.__AFOS_ONLINE_OBSERVER__,modules:window.__AFOS_ONLINE_OBSERVER__?[...window.__AFOS_ONLINE_OBSERVER__.loader.entries()].map(x=>({id:x.options.name,state:x.fiber?.state,error:x.fiber?.error?.message})):[]})')}catch{}
 await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),stack:(error as Error).stack,results,networkFacts,consoleFacts,bootstrapFacts,page,ownerFacts:face?.online.ownerFacts()},null,2)+'\n').catch(()=>{});console.error(error);release();foreign?.destroy();face?.window.destroy();await f?.cleanup().catch(()=>{});clearTimeout(timer);app.exit(1);
}})();
