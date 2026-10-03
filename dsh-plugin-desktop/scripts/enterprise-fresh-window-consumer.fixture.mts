import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs';
import { createEnterpriseWindowOwner } from '../src/enterprise-window.ts';
import { runtimeDraftProjection } from '../src/enterprise-electron.ts';
import { EnterpriseCliHost, type EnterpriseCliReady } from '../src/enterprise-cli-host.ts';
import type { MainCallerRequest } from '../src/enterprise-caller-proof.ts';
import { redactRuntimeLog } from '../src/runtime-security.ts';

const output = process.env.AFOS_ONLINE_OUTPUT!, assets = process.env.AFOS_ONLINE_APP!, runtime = process.env.AFOS_ONLINE_RUNTIME!, node = process.env.AFOS_ONLINE_NODE!;
if (!output || !assets || !runtime || !node) throw Error('private fresh window paths required');
app.disableHardwareAcceleration(); app.setPath('userData', join(output,'userdata')); app.setPath('crashDumps', join(output,'crash'));
protocol.registerSchemesAsPrivileged([{scheme:'afos-local',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const results: unknown[] = [], consoleFacts: unknown[] = [], networkFacts: unknown[] = [], lifecycle: unknown[] = [], ipcTrace: {event:'handle'|'remove';channel:string;ordinal:number}[] = [];
let phase = 'setup';
function mark(value: string) { phase = value; const active = owner?.current(); writeFileSync(join(output,'checkpoint.json'),JSON.stringify({phase,results,lifecycle,allClosed,closed,activeWindowIds:BrowserWindow.getAllWindows().map(window => window.id),ownerFacts:active?.online.ownerFacts(),hostPresent:host?.processId() !== undefined,readyAborted:privateReady?.signal.aborted,activePermits:permits.filter(signal => !signal.aborted).length},null,2) + '\n'); }
function record(value: unknown) { results.push(value); mark((value as {case:string}).case); }
const permits: AbortSignal[] = [], secrets = new Set<string>(), windows: BrowserWindow[] = [], partitions: string[] = [];
const liveHandlers = new Set<string>();
const measuredIpc = { handle(channel: string,handler: Parameters<typeof ipcMain.handle>[1]) { assert.equal(liveHandlers.has(channel),false); ipcTrace.push({event:'handle',channel,ordinal:windows.length}); ipcMain.handle(channel,handler); liveHandlers.add(channel); },removeHandler(channel: string) { ipcTrace.push({event:'remove',channel,ordinal:windows.length}); ipcMain.removeHandler(channel); liveHandlers.delete(channel); } } as typeof ipcMain;
let allClosed = 0, closed = 0, beforeQuit = 0, cleanupFailures = 0, modelCalls = 0, privateReady: EnterpriseCliReady | undefined, lastRequest: MainCallerRequest | undefined;
let owner: ReturnType<typeof createEnterpriseWindowOwner> | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined, host: EnterpriseCliHost | undefined;
type Deferred = { readonly promise: Promise<void>; resolve(): void };
let preparation: { readonly loaded: Deferred; readonly ready: Deferred; readonly drain: Deferred } | undefined;
let closeDrain: Deferred | undefined;
app.on('window-all-closed', () => { ++allClosed; lifecycle.push({event:'window-all-closed'}); });
// Observe native quitting without holding it; the owned Close path must drain before last-window destruction.
app.on('before-quit', () => { ++beforeQuit; lifecycle.push({event:'before-quit'}); });
const safe = (value: unknown) => { let text = redactRuntimeLog(String(value)); for (const secret of secrets) text = text.replaceAll(secret,'[PRIVATE_RUNTIME_VALUE]'); return text.replace(/127\.0\.0\.1:[0-9]+/g,'127.0.0.1:PORT'); };
const face = () => { const value = owner?.current(); if (!value) throw Error('fixture/no-active-window'); return value; };
const ui = (code: string) => Promise.race([face().window.webContents.executeJavaScript(code,true),new Promise<never>((_resolve,reject) => { const timer = setTimeout(() => reject(Error('fixture/UI-operation-timeout')),15000); timer.unref(); })]);
async function waitFor(test: () => boolean | Promise<boolean>, label: string, limit = 12000) { const deadline = Date.now() + limit; while (Date.now() < deadline) { if (await test()) return; await new Promise(r => setTimeout(r,25)); } throw Error('fresh condition failed: ' + label); }
async function online() { await waitFor(async () => { try { return !!(await ui('!!window.__AFOS_ONLINE_OBSERVER__?.connection.generation.getSnapshot()')); } catch { return false; } },'original SDK ready'); }
const unary = (method: string, payload: unknown = {}) => ui(`window.__AFOS_ONLINE_OBSERVER__.connection.rpc.call('/api',${JSON.stringify(method)},${JSON.stringify(payload)})`);
const local = () => waitFor(() => face().window.webContents.getURL() === 'afos-local://drafts/index.html','local face');
const stopped = () => waitFor(() => host?.processId() === undefined,'CLI stopped',7000);
const toolReply = (name: string,args: unknown) => [{type:'block-start',index:0,blockType:'tool-call'},{type:'tool-call-delta',index:0,id:'call-'+name,name,argumentsDelta:JSON.stringify(args)},{type:'block-end',index:0,block:{type:'tool-call',id:'call-'+name,name,arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}];
const timer = setTimeout(() => { console.error('fresh window bounded timeout: ' + phase); app.exit(1); },115000);
void (async () => { try {
  await app.whenReady(); await mkdir(output,{recursive:true});
  f = await fixture({stopHost:async () => host?.stop(),model:async () => { ++modelCalls; return modelCalls === 1 ? toolReply('afos_read_snapshot',{materialId:f!.ref.materialId,revisionId:f!.ref.revisionId}) : modelCalls === 2 ? toolReply('afos_render_draft',{text:'Retained owned local draft.',sources:[f!.ref]}) : [{type:'finish',reason:{kind:'stop'}}]; }});
  await f.ready(); phase = 'Main-ready';
  owner = createEnterpriseWindowOwner({createWindow: options => { assert.ok(!windows.length || windows.some(window => !window.isDestroyed()),'precreate before last old physical window closes'); const window = new BrowserWindow({...options,show:false}); const held = preparation; if (held) { const load = window.loadURL.bind(window); window.loadURL = (url,loadOptions) => load(url,loadOptions).then(async () => { held.loaded.resolve(); await held.ready.promise; }); } windows.push(window); partitions.push(options.webPreferences!.partition!); lifecycle.push({event:'created',ordinal:windows.length,physical:BrowserWindow.getAllWindows().length}); return window; },ipc:measuredIpc,appPath:assets,
    capabilities:() => f!.main.localDraftCapabilities(),projectDraft:runtimeDraftProjection(runtime),
    activated: active => { lifecycle.push({event:'activated',ordinal:windows.indexOf(active.window)+1}); active.window.webContents.on('console-message',(_event:any,level:any,message:any) => consoleFacts.push({message:safe(typeof level === 'object' ? level.message : message)})); active.window.webContents.session.webRequest.onSendHeaders(details => networkFacts.push({method:details.method,path:new URL(details.url).pathname,type:details.resourceType,frameTop:!!details.frame && details.frame === active.window.webContents.mainFrame,witness:Object.keys(details.requestHeaders).some(key => key.toLowerCase() === 'x-afos-native-witness')})); },
    closed:() => { ++closed; lifecycle.push({event:'current-closed'}); },loadFailed:() => { ++cleanupFailures; lifecycle.push({event:'load-failed'}); },cleanupFailed:() => { ++cleanupFailures; lifecycle.push({event:'cleanup-failed'}); },
    startHost:() => f!.main.startHost(),stopHost:() => { const work = f!.main.stopEnterprise(), drain = preparation?.drain ?? closeDrain; return drain ? work.then(() => drain.promise) : work; },
  });
  await face().ready;
  host = new EnterpriseCliHost({executable:node,runtimeProfile:runtime,model:{provider:'afos-managed',model:'fixed-model',maxTokens:64},callerIssuer:{assertRequest:async (request,signal) => { secrets.add(request.witness); const permit = await face().online.callerIssuer.assertRequest(request,signal); permits.push(permit.signal); lastRequest = request; return permit; }},writeLog:text => consoleFacts.push({cli:safe(text)}),
    online:{frontendIndex:join(assets,'renderer/afos-online/index.html'),onReady:async ready => { privateReady = ready; secrets.add(ready.authenticatedUrl); secrets.add(new URL(ready.authenticatedUrl).searchParams.get('token')!); await face().online.showOnline(ready,f!.main.localDraftCapabilities().accountSignal); for (const cookie of await face().window.webContents.session.cookies.get({url:`http://127.0.0.1:${ready.port}/`})) secrets.add(cookie.value); }},
    onUnexpectedStop:async () => { owner?.cancelStart(); await f!.main.stopEnterprise(); },
  });
  assert.deepEqual(await host.capabilities(),{ingressValidated:false,sandbox:'unavailable'});
  f.startHook((signal:any,layout:any,authority:any,business:any) => host!.start(layout,authority,signal,business)); f.capability({ingressValidated:true,sandbox:'full'}); // Offline fixture only.
  await owner.startHost(); await online(); phase = 'first-SDK-ready';
  const initial = await ui("({node:typeof require,local:typeof window.afosLocalDrafts,original:window.__DSH_BOOT__.entries.filter(x=>x.id!=='afos-online-test-observer').length,active:[...window.__AFOS_ONLINE_OBSERVER__.loader.entries()].filter(x=>x.fiber?.state===2).length})");
  assert.deepEqual(initial,{node:'undefined',local:'undefined',original:23,active:24});
  const firstSession = face().window.webContents.session, firstFrame = face().window.webContents.mainFrame, firstWindow = face().window, firstPid = host.processId();
  const accountSignal = f.main.localDraftCapabilities().accountSignal, cookies = await firstSession.cookies.get({url:`http://127.0.0.1:${privateReady!.port}/`});
  assert.equal(firstSession.isPersistent(),false); assert.equal(cookies.length,1); assert.equal(cookies[0]!.httpOnly,true); assert.equal(cookies[0]!.sameSite,'strict'); assert.equal(await ui("document.cookie.includes('dsh-auth-')"),false);
  assert.equal((await unary('afos/drafts/state')).ok,true); assert.equal((await unary('afos/drafts/materials')).value.length,1);
  record({case:'original-cli-private-ready-cookie23',pass:true,ephemeralSession:true,originalModules:23,fixtureCapsOnly:true});
  // One explicit public Start action creates the persisted draft; crash/restart must never replay it.
  await ui("window.__AFOS_ONLINE_OBSERVER__.layout.selectPanel('afos-enterprise-drafts')");
  const started = await unary('afos/drafts/start',{sources:[f.ref],goal:'Retain a local draft across renderer crash.',operationId:'fresh-window-explicit-run'}); assert.equal(started.ok,true);
  await waitFor(async () => { const state = await unary('afos/drafts/state'); return state.ok && state.value.drafts.some((draft:any) => draft.content === 'Retained owned local draft.'); },'persisted draft');
  const retained = await unary('afos/drafts/state'); assert.equal(retained.value.drafts.length,1); assert.equal(modelCalls,3); assert.equal(f.tables.runs.size,1);
  const originalRunCount = f.tables.runs.size, originalModelCalls = modelCalls;
  record({case:'explicit-run-local-recovery-baseline',pass:true,explicitRuns:1,modelCalls:3});
  const reloadReady = privateReady, startsBeforeReload = f.starts(), reloadFinished = new Promise<void>(resolve => firstWindow.webContents.once('did-finish-load',() => resolve()));
  firstWindow.webContents.reload(); await reloadFinished; await online(); assert.equal(face().window,firstWindow); assert.equal(host.processId(),firstPid); assert.equal(f.starts(),startsBeforeReload); assert.equal(privateReady,reloadReady); assert.equal((await unary('afos/drafts/state')).value.drafts.length,1);
  record({case:'ordinary-reload-keeps-owned-window-and-host',pass:true,noAutomaticStart:true});
  // dispose is the exact owned 'closed' callback. Do not replay Electron's private runtime listeners.
  const oldFace = face(), oldReady = privateReady!, oldClosed = oldFace.dispose;
  assert.ok(lastRequest); const oldRequest = lastRequest!; assert.ok(permits.some(signal => !signal.aborted));
  const stopsBefore = f.stops(), startsBefore = f.starts();
  const gone = new Promise<void>(resolve => firstWindow.webContents.once('render-process-gone',() => { assert.ok(permits.every(signal => signal.aborted)); assert.equal(oldReady.signal.aborted,true); assert.equal(firstWindow.webContents.mainFrame.detached,true); resolve(); }));
  firstWindow.webContents.forcefullyCrashRenderer(); await gone; await stopped(); await local(); assert.ok(f.stops() > stopsBefore); assert.equal(f.starts(),startsBefore); assert.equal(windows.length,1); assert.equal(firstWindow.isDestroyed(),false);
  await assert.rejects(oldFace.online.callerIssuer.assertRequest(oldRequest,new AbortController().signal)); await assert.rejects(oldFace.online.showOnline(oldReady,accountSignal));
  record({case:'real-renderer-crash-sync-cutoff-old-witness-refused',pass:true,detached:true,hostStopped:true,noAutomaticStart:true,oldPhysicalWindowRetained:true});
  await owner.startHost(); await online(); const second = face(), secondPid = host.processId();
  assert.notEqual(second.window,firstWindow); assert.notEqual(second.window.webContents.mainFrame,firstFrame); assert.notEqual(second.window.webContents.session,firstSession); assert.notEqual(partitions[1],partitions[0]); assert.equal(firstWindow.isDestroyed(),true); assert.equal(BrowserWindow.getAllWindows().length,1); assert.equal(allClosed,0); assert.equal(closed,0); assert.notEqual(privateReady,oldReady); assert.notEqual(secondPid,firstPid); assert.equal(f.main.localDraftCapabilities().accountSignal,accountSignal);
  const rebind = ipcTrace.filter(row => row.ordinal === 2); assert.deepEqual(rebind.map(row => row.event),['remove','remove','handle','handle']); assert.equal(liveHandlers.size,2);
  assert.equal((await unary('afos/drafts/state')).value.drafts.length,1); assert.equal((await unary('afos/drafts/materials')).value.length,1); const newCookies = await second.window.webContents.session.cookies.get({url:`http://127.0.0.1:${privateReady!.port}/`}); assert.equal(newCookies.length,1); assert.equal(newCookies[0]!.httpOnly,true); assert.equal(newCookies[0]!.sameSite,'strict'); assert.notEqual(newCookies[0]!.value,cookies[0]!.value);
  record({case:'explicit-native-start-fresh-window-session-frame-cookie-sdk',pass:true,newOwnedWindow:true,newEphemeralSession:true,newPartition:true,newFrame:true,newPrivateReady:true,newCookie:true,localDraftRetained:true,oldHandlersRemovedBeforeNewInstallation:true,oneActiveWindow:true,noIntermediateAllClosed:true});
  const lateStops = f.stops(), lateIpc = ipcTrace.length; oldClosed(); oldFace.dispose(); assert.equal(owner.current(),second); assert.equal(f.stops(),lateStops); assert.equal(host.processId(),secondPid); assert.equal(closed,0); assert.equal(ipcTrace.length,lateIpc); assert.equal(liveHandlers.size,2); assert.equal((await unary('afos/drafts/state')).ok,true);
  record({case:'late-old-closed-and-dispose-cannot-kill-new-owner',pass:true,replayedActualOldCallbacks:true,newHostAndIpcRemainActive:true});
  const secondReady = privateReady!, secondGone = new Promise<void>(resolve => second.window.webContents.once('render-process-gone',() => resolve())); second.window.webContents.forcefullyCrashRenderer(); await secondGone; assert.equal(secondReady.signal.aborted,true); await stopped(); await owner.startHost(); await online(); assert.equal(windows.length,3); assert.equal(BrowserWindow.getAllWindows().length,1); assert.equal(allClosed,0); assert.equal((await unary('afos/drafts/state')).value.drafts.length,1);
  record({case:'repeated-real-renderer-crash-explicit-replacement',pass:true,oneActiveWindow:true});
  const hostCrashWindow = face().window, hostCrashReady = privateReady!; process.kill(host.processId()!,'SIGKILL'); await stopped(); await local(); assert.equal(hostCrashReady.signal.aborted,true); const hostCrashStarts = f.starts(); await new Promise(resolve => setTimeout(resolve,150)); assert.equal(f.starts(),hostCrashStarts); assert.equal(windows.length,3);
  await owner.startHost(); await online(); assert.equal(face().window,hostCrashWindow); await assert.rejects(face().online.showOnline(hostCrashReady,accountSignal)); assert.equal((await unary('afos/drafts/state')).value.drafts.length,1);
  record({case:'host-crash-local-rollback-explicit-restart-healthy-frame',pass:true,noAutomaticStart:true,sameHealthyWindow:true,oldReadyRefused:true});
  owner.cancelStart(); await f.main.selectProject('p1'); await stopped(); await local(); assert.equal((await Promise.resolve(f.main.localDraftCapabilities().drafts())).length,1); const beforeProjectRestart = windows.length; await owner.startHost(); await online(); assert.equal(windows.length,beforeProjectRestart); assert.equal((await unary('afos/drafts/state')).value.drafts.length,1);
  record({case:'project-reselection-cutoff-preserves-local-copy',pass:true,noNewWindowForHealthyFrame:true});
  owner.cancelStart(); await f.main.logout(); await stopped(); await local(); f.principal('bob'); await f.ready(); await owner.startHost(); await online(); assert.equal((await unary('afos/drafts/state')).value.drafts.length,0);
  owner.cancelStart(); await f.main.logout(); await stopped(); await local(); f.principal('alice'); await f.ready(); await owner.startHost(); await online(); assert.equal((await unary('afos/drafts/state')).value.drafts.length,1);
  record({case:'account-switch-isolates-and-restores-retained-local-draft',pass:true,bobDrafts:0,aliceDrafts:1});
  owner.cancelStart(); await f.main.suspend(); await stopped(); await local(); const suspendStarts = f.starts(); await new Promise(resolve => setTimeout(resolve,150)); assert.equal(f.starts(),suspendStarts); await f.ready(); await owner.startHost(); await online();
  assert.equal(f.tables.runs.size,originalRunCount); assert.equal(modelCalls,originalModelCalls); assert.equal((await unary('afos/drafts/state')).value.drafts.length,1);
  record({case:'suspend-no-automatic-run-or-host-replay',pass:true,explicitRuns:1,modelCalls:3});
  for (const first of ['ready','drain']) {
    const previous = face(), starts = f.starts(), beforeAllClosed = allClosed;
    const gone = new Promise<void>(resolve => previous.window.webContents.once('render-process-gone',() => resolve()));
    previous.window.webContents.forcefullyCrashRenderer(); await gone; await stopped(); await local();
    const held = {loaded:Promise.withResolvers<void>(),ready:Promise.withResolvers<void>(),drain:Promise.withResolvers<void>()}; preparation = held;
    let loaded = false; void held.loaded.promise.then(() => { loaded = true; });
    const pending = owner.startHost(), interrupted = assert.rejects(pending,/enterprise\/window-start-stopped/);
    await waitFor(() => loaded,'replacement real local page loaded',15000); const failed = face(); mark('preparation-close-' + first);
    failed.window.close(); failed.window.close(); assert.equal(failed.window.isDestroyed(),false); assert.equal(failed.online.ownerFacts().documentActive,false);
    if (first === 'ready') held.ready.resolve(); else held.drain.resolve();
    await waitFor(() => failed.window.isDestroyed(),'interrupted replacement discarded',15000); assert.equal(previous.window.isDestroyed(),false);
    if (first === 'ready') held.drain.resolve(); else held.ready.resolve();
    await interrupted; preparation = undefined; assert.equal(owner.current(),previous); assert.equal(f.starts(),starts); assert.equal(allClosed,beforeAllClosed);
    await owner.startHost(); await online(); const future = face(), futurePid = host.processId(), stops = f.stops(), ipcCount = ipcTrace.length;
    failed.dispose(); failed.dispose(); assert.equal(owner.current(),future); assert.equal(future.window.isDestroyed(),false); assert.equal(host.processId(),futurePid); assert.equal(f.stops(),stops); assert.equal(ipcTrace.length,ipcCount); assert.equal(liveHandlers.size,2);
    assert.equal(BrowserWindow.getAllWindows().length,1); assert.equal(allClosed,beforeAllClosed); assert.equal(cleanupFailures,0); assert.equal((await unary('afos/drafts/state')).value.drafts.length,1); assert.equal(f.tables.runs.size,originalRunCount); assert.equal(modelCalls,originalModelCalls);
    record({case:'preparation-native-close-' + first + '-first-explicit-retry',pass:true,realWindowClose:true,realMainStop:true,boundedCompletionOrder:first,oldPhysicalShellRetained:true,explicitRetryReady:true,lateFailedCallbackIsolated:true,noRunReplay:true});
  }
  const finalReady = privateReady!, finalWindow = face().window, finalStops = f.stops(), finalClosed = closed; closeDrain = Promise.withResolvers<void>(); mark('before-current-native-close'); finalWindow.close(); finalWindow.close(); mark('after-current-native-close-request'); assert.equal(finalWindow.isDestroyed(),false); assert.equal(finalReady.signal.aborted,true); assert.ok(permits.every(signal => signal.aborted)); await assert.rejects(owner.startHost(),/enterprise\/window-owner-closing/);
  let closingRendererGone = false; finalWindow.webContents.once('render-process-gone',() => { closingRendererGone = true; }); finalWindow.webContents.forcefullyCrashRenderer(); await waitFor(() => closingRendererGone,'Renderer crash during owned native Close',15000); assert.equal(finalWindow.isDestroyed(),false); assert.equal(f.stops(),finalStops + 1,'Close already owns the stop during Renderer crash'); closeDrain.resolve(); closeDrain = undefined;
  await waitFor(() => finalWindow.isDestroyed(),'native Close after drain',15000); assert.equal(owner.current(),undefined); assert.equal(liveHandlers.size,0); await stopped(); mark('after-final-CLI-stopped'); assert.equal(closed,finalClosed + 1); assert.equal(allClosed,1); assert.equal(BrowserWindow.getAllWindows().length,0); assert.equal(cleanupFailures,0); assert.equal(f.stops(),finalStops + 1,'closed must not enqueue a duplicate stop against the native quit cutoff');
  await f.main.suspend(); await new Promise(resolve => setTimeout(resolve,0)); assert.equal(cleanupFailures,0);
  await assert.rejects(owner.startHost(),/enterprise\/window-owner-refused/);
  record({case:'current-window-close-sync-cutoff-and-final-all-closed-only',pass:true,noActiveWindow:true,oneOwnedCloseStop:true,rendererCrashDuringCloseSharesStop:true,subsequentRealMainSuspendNoCleanupFailure:true,fullProductionQuitChainNotClaimed:true});
  mark('before-Main-cleanup'); await f.cleanup(); f = undefined; mark('after-Main-cleanup');
  assert.ok(networkFacts.some((row:any) => row.path === '/api/remote.mux' && row.witness && row.frameTop)); assert.ok(networkFacts.some((row:any) => row.path === '/api/afos/drafts/state' && row.witness && row.frameTop));
  const sink = JSON.stringify({results,consoleFacts,networkFacts,lifecycle,ipcTrace}); for (const secret of secrets) assert.equal(sink.includes(secret),false);
  await writeFile(join(output,'result.json'),JSON.stringify({scope:'actual Electron43.3/Xvfb Linux --no-sandbox, original CLI/23Loader offline component; owned native Close drains before destroy; no Windows/production AT',results,lifecycle,ipcTrace,networkFacts,consoleFacts,beforeQuitObserved:beforeQuit,secretCheck:{valuesChecked:secrets.size,noValuesInSink:true,valuesPersisted:false}},null,2) + '\n'); console.log(JSON.stringify({pass:results.length,cases:results.map((row:any) => row.case)})); clearTimeout(timer); app.exit(0);
} catch (error) {
  writeFileSync(join(output,'failure.json'),JSON.stringify({phase,error:safe(error),stack:safe((error as Error).stack),results,lifecycle,networkFacts,consoleFacts,ownerFacts:owner?.current()?.online.ownerFacts()},null,2) + '\n'); console.error(safe(error)); owner?.current()?.window.destroy(); await f?.cleanup().catch(() => {}); clearTimeout(timer); app.exit(1);
} })();
