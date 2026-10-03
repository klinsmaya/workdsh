import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import assert from 'node:assert/strict';
import { writeFile, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../../enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs';
import { createEnterpriseLocalWindow } from '../src/enterprise-window.ts';
import { runtimeDraftProjection } from '../src/enterprise-electron.ts';

// Test-only Main consumer. This never enables the production Host capability.
const output = process.env.AFOS_ELECTRON_TEST_OUTPUT;
const assets = process.env.AFOS_ELECTRON_TEST_APP;
if (!output || !assets) throw Error('fixture requires private test paths');
app.on('window-all-closed', () => {});
app.setPath('userData', join(output, 'userdata'));app.disableHardwareAcceleration(); app.setPath('crashDumps', join(output, 'crash'));
protocol.registerSchemesAsPrivileged([{ scheme: 'afos-local', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const results: unknown[] = [], consoleMessages: unknown[] = [];
const ipcTrace: { channel:string; outcome:'pending'|'success'|'refused' }[]=[];
const measuredIpc = { handle(channel:string,handler:any){ipcMain.handle(channel,async(...args:any[])=>{const row={channel,outcome:'pending' as 'pending'|'success'|'refused'};ipcTrace.push(row);try{const value=await handler(...args);row.outcome='success';return value;}catch(error){row.outcome='refused';throw error;}});},removeHandler(channel:string){ipcMain.removeHandler(channel);} };
let projectionPause: { promise: Promise<unknown>; resolve(value?: unknown): void; entered: boolean } | undefined;
let face: ReturnType<typeof createEnterpriseLocalWindow> | undefined, foreign: BrowserWindow | undefined, other: BrowserWindow | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined;
process.on('uncaughtException',error=>{console.error('fixture uncaught exception',error);app.exit(1);});
const timer = setTimeout(() => { console.error('bounded fixture timeout'); app.exit(1); }, 70000);
const ui = (code: string) => face!.window.webContents.executeJavaScript(code, true);
async function until(code: string, label: string) {
 const deadline = Date.now() + 15000;
 while (Date.now() < deadline) { if (await ui(code)) return; await new Promise(resolve => setTimeout(resolve, 75)); }
 throw Error('fixture condition failed: ' + label);
}
void (async () => { try {
 await app.whenReady(); await mkdir(output, { recursive: true });
 const dangerousName = ('<img src=x onerror=globalThis.__BAD_PROJECT__=true> {\"__jsExpr\":\"globalThis.__BAD_PROJECT__=true\"} ' + '名'.repeat(1024)).slice(0,1024);
 f = await fixture({ response: async (request: {action:string}) => request.action === 'projects.listAllowed' ? Response.json({contractVersion:'afos.bridge.v1',principalId:'alice',items:[{id:'p1',organizationId:'org1',name:dangerousName}],nextCursor:null}) : undefined }); await f.ready(); await f.main.readRevision(f.ref);
 const run = await f.main.authorize([f.ref], 'electron-local-fixture-run'); await f.bind(run.runId, 'electron-owned-session');
 const original = '<img src=x onerror="window.__BAD_PREVIEW__=true"> Main-owned offline draft';
 const record = await f.main.createDraft(run.runId, 'electron-owned-session', original, 'electron-local-fixture-draft');
 await f.main.stopEnterprise(); const networkBefore = f.calls.length;
 face = createEnterpriseLocalWindow({ createWindow: options => new BrowserWindow(options), ipc: measuredIpc as typeof ipcMain, appPath: assets,
   capabilities: () => f!.main.localDraftCapabilities(), projectDraft: async record => { const pause=projectionPause;if(pause){pause.entered=true;await pause.promise;}return runtimeDraftProjection(process.env.AFOS_ELECTRON_TEST_PROFILE ?? fileURLToPath(new URL('../../workdsh-web/packages/providers/enterprise-profile/', import.meta.url)))(record); },
   closed() {}, loadFailed() { console.error('local document load failed'); } });
 face.window.webContents.on('console-message', (event) => { consoleMessages.push({ level: event.level, message: event.message }); });
 await face.ready;
 await until("!!window.__AFOS_LOCAL_OBSERVER__?.get('uiWorkspace') && document.querySelector('#afos-draft-editor')", 'original Loader/Slots/local panel');
 const before = await ui(`(() => {const c=window.__AFOS_LOCAL_OBSERVER__;return{api:Object.keys(window.afosLocalDrafts),states:[...c.loader.entries()].map(e=>({id:e.options.name,state:e.fiber?.state,error:e.fiber?.error?.message})),slots:c.slots.entriesOfSlot('main').map(e=>e.options.key),body:document.body.innerText,editor:document.querySelector('#afos-draft-editor').value,preferences:{node:typeof require,ipc:typeof ipcRenderer},bad:!!window.__BAD_PREVIEW__};})()`);
 assert.deepEqual(before.api.sort(), ['edit', 'state', 'subscribe']); assert.ok(before.slots.includes('afos-enterprise-drafts')); assert.equal(before.editor, original); assert.equal(before.bad, false); assert.equal(before.preferences.node, 'undefined');
 assert.equal(before.states.length, 24); assert.ok(before.states.every((row: {state:number}) => row.state === 2), JSON.stringify(before.states));
 assert.ok(before.body.includes(dangerousName)); assert.equal(await ui('!!window.__BAD_PROJECT__'), false);
 assert.ok(before.body.includes('本地草稿')); assert.ok(!before.body.includes('生成本地草稿')); assert.ok(!before.body.includes('打开原生会话'));
 assert.equal(face.window.webContents.getLastWebPreferences().sandbox, true); assert.equal(face.window.webContents.getLastWebPreferences().contextIsolation, true); assert.equal(face.window.webContents.getLastWebPreferences().nodeIntegration, false);
 results.push({ case:'AFOS-ELECTRON-01', pass:true, before, scope:'original 24-module graph with one test-only public observer; real preload/top-frame/Slots; Linux no OS sandbox' });
 const content = 'Edited offline through original Panel <script>window.__BAD_PREVIEW__=true</script> [click](javascript:globalThis.__BAD_PREVIEW__=true) {"__jsExpr":"globalThis.__BAD_PREVIEW__=true"}';
 await ui(`(() => {const e=document.querySelector('#afos-draft-editor');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(content)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await until("[...document.querySelectorAll('button')].some(e=>e.textContent==='保存本地编辑'&&!e.disabled)", 'save enabled');
 await ui("[...document.querySelectorAll('button')].find(e=>e.textContent==='保存本地编辑').click()");
 await until("document.body.innerText.includes('当前正文已保存在本地工作副本')", 'canonical saved');
 assert.equal(f.main.localDraftCapabilities().drafts()[0].content, content); assert.equal(f.calls.length, networkBefore); assert.equal(f.tables.artifacts.size, 0); assert.equal(await ui('!!window.__BAD_PREVIEW__'), false);
 results.push({case:'AFOS-ELECTRON-02',pass:true,localMainPersisted:true,noEnterpriseRequests:true,pureText:true});
 assert.equal(await ui(`window.afosLocalDrafts.edit({draftId:${JSON.stringify(record.draftId)},content:'bad',token:'forbidden'}).then(()=>false,()=>true)`), true);
 assert.equal(await ui("window.afosLocalDrafts.edit({draftId:'foreign-draft',content:'foreign'}).then(()=>false,()=>true)"), true);
 for (const path of ['/api/file/owned', '/api/session/list', '/api/afos/drafts/start', '/api/remote.mux', '/upload', '/not-in-manifest.js']) {
   const response = await face.window.webContents.session.fetch('afos-local://drafts' + path); assert.equal(response.status, 404);
 }
 const refusedFetch = await ui("fetch('https://enterprise.example/api').then(()=>false,()=>true)"); assert.equal(refusedFetch, true);
 foreign = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'afos-local-drafts',preload:fileURLToPath(new URL('./enterprise-preload.cjs',import.meta.url))}});
 await foreign.loadURL('afos-local://drafts/index.html');
 assert.equal(await foreign.webContents.executeJavaScript("window.afosLocalDrafts.state().then(()=>false,()=>true)"), true);
 other = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:fileURLToPath(new URL('./enterprise-preload.cjs',import.meta.url))}}); await other.loadURL('data:text/html,<p>foreign document</p>');
 assert.equal(await other.webContents.executeJavaScript('typeof window.afosLocalDrafts'), 'undefined');
 foreign.destroy(); foreign=undefined; other.destroy();other=undefined;
 const beforeUrl = face.window.webContents.getURL(); await ui("window.open('https://enterprise.example/')"); await new Promise(resolve=>setTimeout(resolve,100)); assert.equal(BrowserWindow.getAllWindows().length,1); assert.equal(face.window.webContents.getURL(),beforeUrl);
 results.push({case:'AFOS-ELECTRON-03',pass:true,unknownPayload:true,foreignDraft:true,foreignWindow:true,foreignDocument:true,rawRoutes404:true,connectCsp:true,popupDenied:true});
 // Real same-id account/project lifetime replacement must discard dirty editor state.
 await ui("(() => {const e=document.querySelector('#afos-draft-editor');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'UNSAVED_OLD_SCOPE');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
 await until("document.querySelector('#afos-draft-editor')?.value==='UNSAVED_OLD_SCOPE'", 'dirty old scope');
 await f.main.selectProject('p1'); face.owner.changed();
 await until(`document.querySelector('#afos-draft-editor')?.value===${JSON.stringify(content)}`, 'same-id scope resets original editor');
 assert.equal(await ui('!!window.__BAD_PROJECT__ || !!window.__BAD_PREVIEW__'),false);
 const framesBefore=face.window.webContents.mainFrame.frames.length;
 await ui("(() => {const e=document.createElement('iframe');e.src='afos-local://drafts/index.html';document.body.append(e);})()");
 await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(await ui("(() => {const e=document.querySelector('iframe');try{return typeof e.contentWindow.afosLocalDrafts==='undefined'}catch{return true}})()"),true);
 assert.ok(consoleMessages.some((row:any)=>String(row.message).includes('frame-src')));
 const childFrames=face.window.webContents.mainFrame.frames.filter(frame=>frame!==face!.window.webContents.mainFrame);
 for(const child of childFrames){const cap=await child.executeJavaScript('typeof window.afosLocalDrafts');assert.equal(cap,'undefined');}
 results.push({case:'AFOS-ELECTRON-05',pass:true,projectName1024:true,expressionTextInert:true,markdownInert:true,dirtySameIdScopeCleared:true,frameCspDenied:true,framesBefore});
 // Existing SenderFrame identity rejects old-document results after a real reload.
 const pending=Promise.withResolvers<unknown>(); projectionPause={...pending,entered:false};
 const oldDocument=ui('window.afosLocalDrafts.state()').then(()=>true,()=>false);
 const started=Date.now();while(!projectionPause.entered&&Date.now()-started<2000)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(projectionPause.entered,true);const oldHandler=ipcTrace.at(-1)!;assert.equal(oldHandler.outcome,'pending');
 const reloaded=new Promise<void>(resolve=>face!.window.webContents.once('did-finish-load',()=>resolve()));face.window.webContents.reload();await reloaded;
 projectionPause=undefined;pending.resolve(undefined);
 assert.equal(oldHandler.outcome,'refused');
 const oldConsumer=await Promise.race([oldDocument,new Promise(resolve=>setTimeout(()=>resolve('destroyed-context-pending'),100))]);assert.notEqual(oldConsumer,true);
 await until("document.querySelector('#afos-draft-editor')", 'original panel restored after reload');
 results.push({case:'AFOS-ELECTRON-06',pass:true,oldDocumentLateResultRefused:true,newDocumentFreshState:true,originalHandlerOutcome:oldHandler.outcome,oldExecuteJavaScriptConsumer:oldConsumer});

 await f.main.logout();
 await until("!document.querySelector('#afos-draft-editor') && !document.body.innerText.includes('Edited offline')", 'logout clears old visible body');
 assert.equal(await ui('window.afosLocalDrafts.state().then(()=>false,()=>true)'),true);
 const after = await ui('document.body.innerText'); results.push({case:'AFOS-ELECTRON-04',pass:true,logoutCutsOldCap:true,visibleBodyCleared:true,after});
 await face.window.webContents.capturePage().then(image=>writeFile(join(output,'local-electron.png'),image.toPNG()));
 await f.ready(); face.owner.changed();await until("document.querySelector('#afos-draft-editor')",'re-authenticated local copy');
 const closing=Promise.withResolvers<unknown>();projectionPause={...closing,entered:false};const oldClosing=ui('window.afosLocalDrafts.state()').then(()=>true,()=>false);
 const closeStarted=Date.now();while(!projectionPause.entered&&Date.now()-closeStarted<2000)await new Promise(resolve=>setTimeout(resolve,25));assert.equal(projectionPause.entered,true);
 const closeHandler=ipcTrace.at(-1)!;face.window.destroy();face=undefined;
 await new Promise(resolve=>setTimeout(resolve,0));assert.equal(closeHandler.outcome,'refused');projectionPause=undefined;closing.resolve(undefined);
 const closeConsumer=await Promise.race([oldClosing,new Promise(resolve=>setTimeout(()=>resolve('destroyed-context-pending'),100))]);assert.notEqual(closeConsumer,true);
 results.push({case:'AFOS-ELECTRON-07',pass:true,actualWindowCloseRevokesPendingProjection:true,originalHandlerOutcome:closeHandler.outcome,oldExecuteJavaScriptConsumer:closeConsumer});
 await f.cleanup(); f=undefined;
 await writeFile(join(output,'result.json'),JSON.stringify({scope:'Linux Electron 43.3.0 --no-sandbox fixture; BrowserWindow sandbox:true; production caps remain false/unavailable; not target desktop AT',results,consoleMessages},null,2)+'\n');
 console.log(JSON.stringify({pass:results.length,scope:'actual original UI + Electron component only',cases:results.map((row:any)=>row.case)}));clearTimeout(timer);app.exit(0);
} catch(error) {
 let page;try{page=face ? await ui('({text:document.body.innerText,api:typeof window.afosLocalDrafts,observer:!!window.__AFOS_LOCAL_OBSERVER__,states:window.__AFOS_LOCAL_OBSERVER__?[...window.__AFOS_LOCAL_OBSERVER__.loader.entries()].map(e=>({id:e.options.name,state:e.fiber?.state,error:e.fiber?.error?.message})):[]})'):undefined;}catch{}
 await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),stack:(error as Error).stack,results,consoleMessages,page},null,2)+'\n').catch(()=>{});
 console.error(error);foreign?.destroy();other?.destroy();face?.window.destroy();await f?.cleanup().catch(()=>{});clearTimeout(timer);app.exit(1);
}
})();
