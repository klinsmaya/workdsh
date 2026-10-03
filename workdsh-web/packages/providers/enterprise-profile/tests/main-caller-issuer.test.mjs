import test from 'node:test';
import assert from 'node:assert/strict';
import { MainCallerProofIssuer,NATIVE_WITNESS_HEADER } from '../../../../../dsh-plugin-desktop/src/enterprise-caller-proof.ts';
import { callerRequestFromHttp,finiteCallerRequest } from '../dist/native-caller-ipc.js';
import { parentCallerIpc } from '../dist/main-caller-ipc.js';
function fixture(t){
 const frame={detached:false,url:'http://127.0.0.1:27890/',top:null};frame.top=frame;
 const session={},contents={id:17,session,mainFrame:frame,isDestroyed:()=>false,getURL:()=>frame.url};
 const account=new AbortController(),host=new AbortController(),window=new AbortController();
 const issuer=new MainCallerProofIssuer({contents,session,partition:'afos-enterprise-ui',authority:'127.0.0.1:27890',uiUrl:frame.url,accountSignal:account.signal,hostSignal:host.signal,windowSignal:window.signal});t.after(()=>issuer.close());
 const details=(id=1,path='/api/afos/drafts/state')=>({id,url:'http://127.0.0.1:27890'+path,method:'POST',resourceType:'xhr',webContentsId:17,webContents:contents,frame,requestHeaders:{}});
 const stamp=(id=1,path='/api/afos/drafts/state')=>issuer.stampRequest(details(id,path))[NATIVE_WITNESS_HEADER];
 const request=(witness,path='/api/afos/drafts/state')=>({witness,method:'POST',path,authority:'127.0.0.1:27890'});
 return {frame,session,contents,account,host,window,issuer,details,stamp,request};
}
test('Main witness is one-use and path/method/authority bound',async t=>{const f=fixture(t),w=f.stamp();const grant=await f.issuer.assertRequest(f.request(w),f.host.signal);grant.assertCurrent();await assert.rejects(f.issuer.assertRequest(f.request(w),f.host.signal));const other=f.stamp(2);await assert.rejects(f.issuer.assertRequest(f.request(other,'/api/afos/drafts/archive'),f.host.signal));await assert.rejects(f.issuer.assertRequest(f.request(other),f.host.signal));grant.close();assert.equal(grant.signal.aborted,true);});
test('original cookie/operator/forged witness cannot be a Main caller',async t=>{const f=fixture(t);for(const witness of ['cookie=approved','operator','A'.repeat(43)])await assert.rejects(f.issuer.assertRequest(f.request(witness),f.host.signal));assert.throws(()=>callerRequestFromHttp({headers:{host:'127.0.0.1:27890',cookie:'auth=original'},method:'POST',url:'/api/afos/drafts/state'}));});
test('actual object identities and current top frame are required',t=>{const f=fixture(t);for(const details of [{...f.details(),webContents:{...f.contents}},{...f.details(),webContentsId:18},{...f.details(),frame:{...f.frame}},{...f.details(),frame:null},{...f.details(),frame:undefined},{...f.details(),webContents:undefined}])assert.throws(()=>f.issuer.stampRequest(details));f.contents.session={};assert.throws(()=>f.stamp());});
test('preview/Agent subframes and foreign windows receive no witness',t=>{const f=fixture(t);assert.throws(()=>f.issuer.stampRequest({...f.details(),frame:{detached:false,url:f.frame.url,top:f.frame}}));assert.throws(()=>f.issuer.stampRequest({...f.details(),resourceType:'subFrame'}));assert.throws(()=>f.issuer.stampRequest({...f.details(),requestHeaders:{'X-AFOS-Native-Witness':'A'.repeat(43)}}));});
test('finite canonical URLs reject alternate host/method/query/encoded path before issuance',t=>{const f=fixture(t);for(const url of ['http://localhost:27890/api/afos/drafts/state','http://127.0.0.1:27890/api/afos/drafts/state?x=1','http://127.0.0.1:27890/api/afos/drafts/%73tate','http://127.0.0.1:27890/api/session/delete','http://127.0.0.1:27890/api/afos/drafts/state#x','http://127.0.0.1:27890/api/afos/drafts/state/'])assert.throws(()=>f.issuer.stampRequest({...f.details(),url}));assert.throws(()=>f.issuer.stampRequest({...f.details(),method:'GET'}));});
test('account/Host/window cutoff synchronously closes captured permits',async t=>{for(const kind of ['account','host','window']){const f=fixture(t),grant=await f.issuer.assertRequest(f.request(f.stamp()),f.host.signal);f[kind].abort();assert.equal(grant.signal.aborted,true);assert.throws(()=>grant.assertCurrent());assert.throws(()=>f.stamp(2));}});
test('navigation/frame replacement invalidates a previously captured permit',async t=>{const f=fixture(t),grant=await f.issuer.assertRequest(f.request(f.stamp()),f.host.signal);f.contents.mainFrame={...f.frame};assert.throws(()=>grant.assertCurrent());});
test('clock advance rejects witnesses and permits before timers run',async t=>{const f=fixture(t),original=Date.now,w=f.stamp();try{Date.now=()=>original()+5001;await assert.rejects(f.issuer.assertRequest(f.request(w),f.host.signal));}finally{Date.now=original;}const grant=await f.issuer.assertRequest(f.request(f.stamp(2)),f.host.signal);try{Date.now=()=>grant.expiresAt;assert.throws(()=>grant.assertCurrent());}finally{Date.now=original;grant.close();}});
test('witness queue is bounded and completion frees only the owned request',t=>{const f=fixture(t);for(let n=1;n<=32;n++)f.stamp(n);assert.throws(()=>f.stamp(33));f.issuer.finishRequest(9);f.stamp(33);assert.throws(()=>f.stamp(34));});
test('IPC proof facts reject duplicate/accessor/body/url/principal fields without evaluation',t=>{const f=fixture(t),value=f.request(f.stamp());for(const extra of ['body','url','actor','token','frame'])assert.throws(()=>finiteCallerRequest({...value,[extra]:'forged'}));let invoked=false;const accessor={...value};Object.defineProperty(accessor,'witness',{get(){invoked=true;return value.witness;},enumerable:true});assert.throws(()=>finiteCallerRequest(accessor));assert.equal(invoked,false);assert.throws(()=>callerRequestFromHttp({method:'POST',url:value.path,headers:{host:value.authority,[NATIVE_WITNESS_HEADER]:value.witness,'X-AFOS-NATIVE-WITNESS':value.witness}}));});
test('private caller keeps real issuer deadline across short business expiry and rechecks fresh authority',async t=>{
 const f=fixture(t),clock=Date.now,cutoffs=[];let reads=0,deny=false;
 const business={currentAuthority:async signal=>{signal.throwIfAborted();reads++;if(deny)throw Error('current authority denied');return {expiresAt:new Date(Date.now()+5000).toISOString()};}};
 const parent=parentCallerIpc(f.issuer,business,f.host.signal,async id=>{cutoffs.push(id);});t.after(()=>parent.close());
 const admitted=await parent.perform('caller.admit',{request:f.request(f.stamp())},f.host.signal);
 assert.ok(admitted.expiresAt>clock()+59000);assert.ok(admitted.expiresAt<=clock()+60000);assert.equal(reads,1);
 try{Date.now=()=>clock()+6000;await parent.perform('caller.assert',{leaseId:admitted.leaseId},f.host.signal);assert.equal(reads,2);assert.equal(cutoffs.length,0);
  deny=true;await assert.rejects(parent.perform('caller.assert',{leaseId:admitted.leaseId},f.host.signal),/current authority denied/);assert.equal(reads,3);
  deny=false;Date.now=()=>admitted.expiresAt;await assert.rejects(parent.perform('caller.assert',{leaseId:admitted.leaseId},f.host.signal));assert.equal(reads,3);
 }finally{Date.now=clock;parent.close();}
 assert.deepEqual(cutoffs,[admitted.leaseId]);
});
test('private caller fresh await cannot revive captured frame after synchronous account cutoff',async t=>{
 const f=fixture(t),entered=Promise.withResolvers(),release=Promise.withResolvers();let hold=false,cutoffs=[];
 const parent=parentCallerIpc(f.issuer,{currentAuthority:async()=>{if(hold){entered.resolve();await release.promise;}return {expiresAt:new Date(Date.now()+5000).toISOString()};}},f.host.signal,async id=>{cutoffs.push(id);});t.after(()=>parent.close());
 const admitted=await parent.perform('caller.admit',{request:f.request(f.stamp())},f.host.signal);hold=true;
 const pending=parent.perform('caller.assert',{leaseId:admitted.leaseId},f.host.signal),rejected=assert.rejects(pending);
 await entered.promise;f.account.abort();assert.deepEqual(cutoffs,[admitted.leaseId]);await rejected;release.resolve();
 await assert.rejects(parent.perform('caller.assert',{leaseId:admitted.leaseId},f.host.signal));assert.equal(cutoffs.length,1);
});
test('private caller admission refuses expired or oversized business authority despite a genuine witness',async t=>{
 for(const ttl of [-1,60000]){const f=fixture(t),parent=parentCallerIpc(f.issuer,{currentAuthority:async()=>({expiresAt:new Date(Date.now()+ttl).toISOString()})},f.host.signal,async()=>{});t.after(()=>parent.close());
  await assert.rejects(parent.perform('caller.admit',{request:f.request(f.stamp())},f.host.signal));}
});
