import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBridge, digest } from '../core.ts';
import { EnterpriseMainSession } from '../../../../../dsh-plugin-desktop/src/enterprise-main.ts';
import { RefreshTokenVault } from '../../../../../dsh-plugin-desktop/src/desktop-auth.ts';

// Real Auth loopback/Broker/Main/recovery/core, injected business rows and HTTPS replies.
// This does not replace real NocoBase/IdP/SQL/desktop acceptance.
async function fixture(options={}) {
  const base=await mkdtemp(join(tmpdir(),'afos-main-flow-'));
  const issuer='https://enterprise.example/api';
  const config={contractVersion:'afos.desktop-config.v1',auth:{issuer,clientId:'desktop',resource:`${issuer}/afos`,scope:'afos offline_access'},releaseId:'fixed-release',policyRevision:'afos.policy.v1'};
  const evidence={issuer,principalId:'alice',clientId:'desktop',grantId:'grant',issuedAt:Date.now(),tokenId:'token',expiresAt:Date.now()+3600000};
  const project={id:'p1',organizationId:'org1',name:'Allowed'};
  const material={id:'m1',projectId:'p1',revisionId:'v1',name:'Source',text:'Server source',hash:digest('Server source')};
  const tables={runs:new Map(),uploads:new Map(),receipts:new Map(),artifacts:new Map(),commitRequests:new Map()};
  let active=true,challenge='',stops=0,starts=0,refresh=0,capability={ingressValidated:false,sandbox:'unavailable'};
  let startHook=async()=>{};const calls=[];
  const store={tokenActive:async()=>active,deviceId:async()=>'device1',
    projects:async()=>({items:[project],nextPosition:null}),project:async(_,id)=>id===project.id?project:undefined,
    materials:async()=>({items:[material],nextPosition:null}),material:async(_,id,rev)=>id===material.id&&rev===material.revisionId?material:undefined,
    get:async(t,id)=>structuredClone(tables[t].get(id)),insert:async(t,v)=>{if(tables[t].has(v.id))throw Error('unique');tables[t].set(v.id,structuredClone(v));},replaceUpload:async v=>tables.uploads.set(v.id,structuredClone(v)),
    transaction:async fn=>fn(store),audit:async()=>{},};
  const bridge=new AgentBridge(store,config.releaseId,config.policyRevision);
  const fetcher=async(url,init)=>{
    if(String(url).endsWith('openid-configuration'))return Response.json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,code_challenge_methods_supported:['S256']});
    if(String(url)===`${issuer}/token`){
      const params=new URLSearchParams(String(init.body));
      assert.equal(params.has('client_secret'),false);
      if(params.get('grant_type')==='authorization_code')assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),challenge);
      return Response.json({access_token:'fixture-access',refresh_token:`fixture-refresh-${++refresh}`,token_type:'Bearer',expires_in:options.shortTokens?1:3600,scope:'afos offline_access'});
    }
    assert.equal(String(url),`${issuer}/afos`);assert.equal(new Headers(init.headers).get('Authorization'),'Bearer fixture-access');
    const request=JSON.parse(init.body);calls.push(request.action);
    try{return Response.json(await bridge.dispatch(evidence,request.action,request.params));}
    catch(error){return Response.json({code:error.code??'afos/internal-error'},{status:error.status??503});}
  };
  const browser=async href=>{const auth=new URL(href);challenge=auth.searchParams.get('code_challenge');const callback=new URL(auth.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({state:auth.searchParams.get('state'),code:'fixture-code'}).toString();assert.equal((await fetch(callback)).status,200);};
  const vault=new RefreshTokenVault(join(base,'vault'),{available:()=>true,encrypt:text=>Buffer.from(text.split('').reverse().join('')),decrypt:data=>data.toString().split('').reverse().join('')});
  const host={stop:async()=>{stops++;},capabilities:async()=>capability,start:async(_layout,_authority,signal)=>{starts++;await startHook(signal);}};
  const main=new EnterpriseMainSession(config,base,vault,host,browser,fetcher);
  const ready=async()=>{await main.signIn();return main.selectProject(project.id);};
  const ref={materialId:material.id,revisionId:material.revisionId,sha256:material.hash};
  return {main,base,config,tables,calls,ref,ready,host,vault,principal:value=>{evidence.principalId=value;},stops:()=>stops,starts:()=>starts,revoke:()=>{active=false;},capability:value=>{capability=value;},startHook:value=>{startHook=value;},cleanup:async()=>{await main.logout();await rm(base,{recursive:true,force:true});}};
}

test('AFOS-CHECK-F01 Main composes PKCE/current authority/durable draft/query-first archive',async()=>{
  const f=await fixture();try{
    const authority=await f.ready();assert.equal(authority.binding.subject,'alice');assert.ok(f.stops()>=2);
    await assert.rejects(f.main.startHost(),/enterprise\/profile-or-sandbox-unverified/);assert.equal(f.starts(),0);
    await f.main.readRevision(f.ref);const run=await f.main.authorize([f.ref],'run-key');
    const draft=await f.main.createDraft(run.runId,'official-session-ref','Draft pending human review','commit-key');
    assert.equal(draft.archive,'local-only');assert.equal(f.tables.artifacts.size,0);
    const receipt=await f.main.archiveFromUser(draft.draftId);assert.equal(receipt.sha256,digest(draft.content));
    assert.equal(f.tables.artifacts.size,1);assert.ok(f.calls.indexOf('runs.getReceipt')<f.calls.indexOf('artifacts.commitDraft'));
    assert.equal((await f.main.archiveFromUser(draft.draftId)).receiptId,receipt.receiptId);assert.equal(f.tables.artifacts.size,1);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F02 current revocation cuts off Main capabilities without old account fallback',async()=>{
  const f=await fixture();try{await f.ready();f.revoke();await assert.rejects(f.main.materials(),/afos\/access-revoked/);await assert.rejects(f.main.currentAuthority(),/enterprise\/select-project-required/);assert.equal(f.starts(),0);}finally{await f.cleanup();}
});

test('AFOS-CHECK-F03 account restore confirms namespace and preserves drafts across process store reopen',async()=>{
  const f=await fixture();try{
    const authority=await f.ready();await f.main.readRevision(f.ref);const run=await f.main.authorize([f.ref],'run-key');
    const draft=await f.main.createDraft(run.runId,'session1','Retained draft','commit-key');
    await f.main.suspend();await f.main.restoreAccount(authority.binding,'p1');
    const receipt=await f.main.archiveFromUser(draft.draftId);assert.equal(receipt.sha256,digest('Retained draft'));
    await f.main.suspend();await assert.rejects(f.main.restoreAccount({...authority.binding,subject:'other'},'p1'),/enterprise\/sign-in-required/);
    await assert.rejects(f.main.currentAuthority(),/enterprise\/select-project-required/);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F04 concurrent authorization admits only one owned run',async()=>{
  const f=await fixture();try{
    await f.ready();await f.main.readRevision(f.ref);
    const results=await Promise.allSettled([f.main.authorize([f.ref],'one'),f.main.authorize([f.ref],'two')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.tables.runs.size,1);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F05 switch waits for late trusted Host start cleanup and refuses old capabilities',async()=>{
  const f=await fixture();try{
    await f.ready();f.capability({ingressValidated:true,sandbox:'full'});
    let entered,release;const waiting=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
    f.startHook(async signal=>{entered();await gate;assert.equal(signal.aborted,true);});
    const starting=f.main.startHost();await waiting;const before=f.stops();const switching=f.main.selectProject('p1');
    await assert.rejects(f.main.currentAuthority(),/enterprise\/select-project-required/);
    assert.equal(f.stops(),before);release();await assert.rejects(starting,/enterprise\/account-changed/);await switching;
    assert.ok(f.stops()>=before+2);assert.equal(f.starts(),1);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F06 old Main continuations never dispatch into a newly selected project',async()=>{
  for(const action of ['materials','readRevision','authorize']){
    const f=await fixture();try{
      await f.ready();await f.main.readRevision(f.ref);
      const original=f.main.currentAuthority.bind(f.main);let resume,entered;
      const gate=new Promise(resolve=>{resume=resolve;});const waiting=new Promise(resolve=>{entered=resolve;});
      f.main.currentAuthority=async signal=>{const result=await original(signal);entered();await gate;return result;};
      const operation=action==='materials'?f.main.materials():action==='readRevision'?f.main.readRevision(f.ref):f.main.authorize([f.ref],'old-run');
      await waiting;await f.main.selectProject('p1');const before=f.calls.length;resume();
      await assert.rejects(operation,/enterprise\/account-changed/);assert.equal(f.calls.length,before);assert.equal(f.tables.runs.size,0);
      f.main.currentAuthority=original;
    }finally{await f.cleanup();}
  }
});

test('AFOS-CHECK-F07 explicit logout credential cleanup survives a rapid new sign-in',async()=>{
  const f=await fixture();try{
    const authority=await f.ready();
    const logout=f.main.logout();const login=f.main.signIn();await Promise.all([logout,login]);
    await f.main.suspend();await assert.rejects(f.main.restoreAccount(authority.binding,'p1'),/enterprise\/sign-in-required/);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F08 sign-in of a new account without selection preserves the other account vault',async()=>{
  const f=await fixture();try{
    const authority=await f.ready();f.principal('bob');await f.main.signIn();await f.main.logout();
    f.principal('alice');const restored=await f.main.restoreAccount(authority.binding,'p1');assert.equal(restored.binding.subject,'alice');
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F09 logout clears credentials despite Host cleanup failure and retries vault failures',async()=>{
  const f=await fixture();try{
    const authority=await f.ready();const namespace=createHash('sha256').update(JSON.stringify(Object.values(authority.binding))).digest('hex');
    const stop=f.host.stop;f.host.stop=async()=>{throw Error('fixture stop failure');};
    await assert.rejects(f.main.logout(),/enterprise\/host-stop-failed/);assert.equal(await f.vault.load(namespace),undefined);f.host.stop=stop;
    await f.ready();const clear=f.vault.clear.bind(f.vault);let fail=true;
    f.vault.clear=async key=>{if(fail)throw Error('fixture vault failure');return clear(key);};
    await assert.rejects(f.main.logout(),/enterprise\/credential-cleanup-failed/);assert.ok(await f.vault.load(namespace));
    fail=false;await f.main.logout();assert.equal(await f.vault.load(namespace),undefined);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F10 logout deletion waits for a late credential rename outside the mutation queue',async()=>{
  const f=await fixture({shortTokens:true});try{
    const authority=await f.ready();const namespace=createHash('sha256').update(JSON.stringify(Object.values(authority.binding))).digest('hex');
    const save=f.vault.save.bind(f.vault);let release,entered;
    const gate=new Promise(resolve=>{release=resolve;});const waiting=new Promise(resolve=>{entered=resolve;});
    f.vault.save=async(key,token)=>{entered();await gate;return save(key,token);};
    const checking=f.main.currentAuthority();await waiting;const logout=f.main.logout();release();
    await assert.rejects(checking,/auth\/account-changed/);await logout;assert.equal(await f.vault.load(namespace),undefined);
  }finally{await f.cleanup();}
});


test('AFOS-CHECK-F11 failed old logout cannot erase a new credential for the same namespace',async()=>{
  const f=await fixture();try{
    const authority=await f.ready();const namespace=createHash('sha256').update(JSON.stringify(Object.values(authority.binding))).digest('hex');
    const clear=f.vault.clear.bind(f.vault);let fails=1;
    f.vault.clear=async key=>{if(fails-- > 0)throw Error('fixture clear failure');return clear(key);};
    await assert.rejects(f.main.logout(),/enterprise\/credential-cleanup-failed/);
    await f.ready();assert.ok(await f.vault.load(namespace));
    f.principal('bob');await f.main.signIn();await f.main.selectProject('p1');await f.main.logout();
    assert.ok(await f.vault.load(namespace));f.principal('alice');await f.main.restoreAccount(authority.binding,'p1');
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F12 model bytes stop on caller cancellation before yielding a prepared byte',async()=>{
  const f=await fixture();try{
    await f.ready();const controller=new AbortController();
    f.main.broker.modelBytes=async function*(){queueMicrotask(()=>controller.abort());yield new Uint8Array([1]);};
    await assert.rejects(f.main.modelBytes({},controller.signal).next());
  }finally{await f.cleanup();}
});


test('AFOS-CHECK-F13 pending namespace cleanup must succeed before a new credential is saved',async()=>{
  const f=await fixture();try{
    await f.ready();const clear=f.vault.clear.bind(f.vault);const save=f.vault.save.bind(f.vault);let saves=0;
    f.vault.clear=async()=>{throw Error('fixture failure');};f.vault.save=async(...args)=>{saves++;return save(...args);};
    await assert.rejects(f.main.logout(),/enterprise\/credential-cleanup-failed/);await f.main.signIn();
    await assert.rejects(f.main.selectProject('p1'),/enterprise\/credential-cleanup-failed/);assert.equal(saves,0);
    await assert.rejects(f.main.currentAuthority(),/enterprise\/select-project-required/);
    f.vault.clear=clear;await f.main.selectProject('p1');assert.equal(saves,1);
  }finally{await f.cleanup();}
});

test('AFOS-CHECK-F14 restore clears a pending logout credential before any refresh',async()=>{
  const f=await fixture();try{
    const authority=await f.ready();const clear=f.vault.clear.bind(f.vault);
    f.vault.clear=async()=>{throw Error('fixture failure');};await assert.rejects(f.main.logout(),/enterprise\/credential-cleanup-failed/);
    f.vault.clear=clear;await assert.rejects(f.main.restoreAccount(authority.binding,'p1'),/enterprise\/sign-in-required/);
  }finally{await f.cleanup();}
});


test('AFOS-CHECK-F15 Host startup refuses an authority snapshot expiring during capabilities',async()=>{
  const f=await fixture();const now=Date.now;try{
    await f.ready();f.host.capabilities=async()=>{Date.now=()=>now()+6000;return {ingressValidated:true,sandbox:'full'};};
    await assert.rejects(f.main.startHost(),/enterprise\/authority-expired/);assert.equal(f.starts(),0);
  }finally{Date.now=now;await f.cleanup();}
});
