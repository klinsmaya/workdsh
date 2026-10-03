import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readdir,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture} from './desktop-fixture.mjs';
import {EnterpriseCliHost} from '../../../../../dsh-plugin-desktop/src/enterprise-cli-host.ts';
const runtimeProfile=fileURLToPath(new URL('../../../../../workdsh-web/packages/providers/enterprise-profile/',import.meta.url));
const model={provider:'afos-managed',model:'fixed-model',maxTokens:64};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function waitStopped(owner){for(let n=0;n<400&&owner.processId()!==undefined;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(owner.processId(),undefined);}
async function composed(t,{decorate,missingRuntime=false}={}){
 const logs=[],owner=new EnterpriseCliHost({executable:process.execPath,runtimeProfile:missingRuntime?join(runtimeProfile,'missing-runtime'):runtimeProfile,model,writeLog:value=>logs.push(value)});
 const f=await fixture({stopHost:()=>owner.stop()});t.after(()=>f.cleanup());await f.ready();
 const actual=await owner.capabilities();assert.deepEqual(actual,{ingressValidated:false,sandbox:'unavailable'});
 f.capability(actual);await assert.rejects(f.main.startHost(),/profile-or-sandbox-unverified/);assert.equal(owner.processId(),undefined);
 f.capability({ingressValidated:true,sandbox:'full'}); // Fixture attestation only; production component remains refused.
 let captured;
 f.startHook(async(signal,layout,authority,business)=>{captured={signal,layout,authority,business};return owner.start(layout,authority,signal,decorate?decorate(business):business);});
 return{...f,owner,logs,captured:()=>captured};
}
test('optional Main owner launches one original CLI with fixed private Core and keeps default capability refused',{timeout:15000},async t=>{
 const f=await composed(t);await f.main.startHost();const pid=f.owner.processId(),{layout}=f.captured();assert.ok(pid&&pid!==process.pid);assert.equal(alive(pid),true);
 const homes=(await readdir(layout.cache)).filter(v=>v.startsWith('cli-'));assert.equal(homes.length,1);
 const home=join(layout.cache,homes[0]),profile=join(home,'profiles','afos-managed');assert.equal((await stat(home)).mode&0o077,0);
 const manifest=JSON.parse(await readFile(join(profile,'package.json'),'utf8'));assert.deepEqual(manifest.dsh.profile.bundles,[]);
 const patch=JSON.parse(await readFile(join(profile,'cordis.patch.yml'),'utf8'));assert.equal(patch.length,1);assert.equal(patch[0].insert.length,1);assert.equal(patch[0].insert[0].id,'afos-private-cli');assert.ok(!JSON.stringify(patch).includes('__jsExpr'));assert.ok(!JSON.stringify(patch).includes('cli-core-consumer'));
 console.log('AFOS_OWNER_EVIDENCE '+JSON.stringify({pid,ppid:process.pid,emptyBundles:true,privateGroup:true,originalReady:true,capability:'refused'}));
 await f.owner.stop();assert.equal(alive(pid),false);assert.equal(f.owner.processId(),undefined);assert.deepEqual((await readdir(layout.cache)).filter(v=>v.startsWith('cli-')),[]);assert.ok((await stat(layout.profile)).isDirectory());assert.ok((await stat(join(layout.profile,'sessions'))).isDirectory());assert.equal(f.tables.artifacts.size,0);
});
test('Main owner excludes inherited preload/credentials and overrides personal DSH_HOME',{timeout:15000},async t=>{
 const names=['NODE_OPTIONS','DSH_HOME','DSH_AGENTS_HOME','AFOS_FIXTURE_PRIVATE_CREDENTIAL','Home','home','UserProfile','userprofile','HOMEDRIVE','HOMEPATH','TEMP','Tmp','TMPDIR'],saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 t.after(()=>{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}});
 const f=await composed(t),hostile=join(f.base,'personal-home');await mkdir(hostile,{mode:0o700});await writeFile(join(hostile,'cordis.patch.yml'),'not a valid fixed patch\n');
 process.env.NODE_OPTIONS='--import /tmp/afos-forbidden-preload-does-not-exist.mjs';process.env.DSH_HOME=hostile;process.env.DSH_AGENTS_HOME=hostile;process.env.AFOS_FIXTURE_PRIVATE_CREDENTIAL='fixture-private-value';
 for(const name of ['Home','home','UserProfile','userprofile','HOMEDRIVE','HOMEPATH','TEMP','Tmp','TMPDIR'])process.env[name]=hostile;
 await f.main.startHost();const pid=f.owner.processId();assert.ok(pid);
 if(process.platform==='linux'){
  const env=(await readFile(`/proc/${pid}/environ`,'utf8')).split('\0');assert.ok(!env.some(value=>value.startsWith('NODE_OPTIONS=')||value.startsWith('AFOS_FIXTURE_PRIVATE_CREDENTIAL=')));assert.ok(!env.includes('DSH_HOME='+hostile));assert.ok(!env.some(value=>/^(?:home|userprofile|homedrive|homepath|temp|tmp|tmpdir)=/iu.test(value)&&value.endsWith('='+hostile)));
  const actualHome=env.find(value=>value.startsWith('DSH_HOME=')).slice(9);assert.ok(env.includes('HOME='+actualHome));assert.ok(env.includes('USERPROFILE='+actualHome));assert.ok(env.includes('DSH_AGENTS_HOME='+join(actualHome,'agents')));for(const name of ['TEMP','TMP','TMPDIR'])assert.ok(env.includes(name+'='+join(actualHome,'tmp')));assert.ok((await stat(join(actualHome,'tmp'))).isDirectory());assert.ok((await stat(join(actualHome,'agents'))).isDirectory());
 }
 assert.ok(!f.logs.join('').includes('fixture-private-value'));assert.equal(f.tables.artifacts.size,0);
});
test('Main owner failed handshake/start closes the child and only its exclusive ephemeral home',{timeout:15000},async t=>{
 let calls=0;const f=await composed(t,{decorate:business=>({...business,currentAuthority:async signal=>{if(++calls===2)throw Error('fixture-private-source-error');return business.currentAuthority(signal);}})});
 await assert.rejects(f.main.startHost(),/cli-host-refused/);const {layout,business}=f.captured();assert.equal(business.hostSignal.aborted,true);assert.equal(f.owner.processId(),undefined);assert.deepEqual((await readdir(layout.cache)).filter(v=>v.startsWith('cli-')),[]);assert.ok((await stat(layout.profile)).isDirectory());assert.ok(!f.logs.join('').includes('fixture-private-source-error'));assert.equal(f.tables.artifacts.size,0);
});
test('Main owner missing runtime refuses before spawning and rejects malformed authority expiry',{timeout:15000},async t=>{
 const missing=await composed(t,{missingRuntime:true});await assert.rejects(missing.main.startHost(),/cli-host-refused/);assert.equal(missing.owner.processId(),undefined);
 const malformed=await composed(t,{decorate:business=>({...business,currentAuthority:async signal=>({...await business.currentAuthority(signal),expiresAt:'invalid-expiry'})})});await assert.rejects(malformed.main.startHost(),/cli-host-refused/);assert.equal(malformed.owner.processId(),undefined);
});
test('Main owner same-account restart and account switch await old CLI exit and invalidate captured business',{timeout:20000},async t=>{
 const f=await composed(t);await f.main.startHost();const oldPid=f.owner.processId(),old=f.captured().business;await f.main.startHost();assert.equal(alive(oldPid),false);assert.equal(old.hostSignal.aborted,true);assert.throws(()=>old.drafts(),/host-changed/);assert.notEqual(f.owner.processId(),oldPid);
 const nextPid=f.owner.processId(),next=f.captured().business;await f.main.logout();assert.equal(alive(nextPid),false);assert.equal(next.hostSignal.aborted,true);f.principal('bob');await f.ready();await f.main.startHost();assert.equal(f.captured().authority.binding.subject,'bob');assert.equal(f.business().drafts().length,0);assert.equal(f.tables.artifacts.size,0);
});
test('Main owner startup cancellation and unexpected child exit remove owned processes',{timeout:20000},async t=>{
 const f=await composed(t),caller=new AbortController(),started=f.main.startHost(caller.signal);for(let n=0;n<200&&f.owner.processId()===undefined;n++)await new Promise(resolve=>setTimeout(resolve,5));const startingPid=f.owner.processId();assert.ok(startingPid);caller.abort();await assert.rejects(started,/cli-host-refused/);assert.equal(alive(startingPid),false);assert.equal(f.owner.processId(),undefined);
 await f.main.startHost();const readyPid=f.owner.processId();process.kill(readyPid,'SIGTERM');await waitStopped(f.owner);assert.equal(alive(readyPid),false);assert.equal(f.tables.artifacts.size,0);
});
test('Main owner deadline bounds non-cooperative preparation and late results cannot spawn a child',{timeout:15000},async t=>{
 let release;const f=await composed(t,{decorate:business=>({...business,currentAuthority:async signal=>{const current=await business.currentAuthority(signal);await new Promise(resolve=>{release=resolve;});return current;}})});
 const began=Date.now();await assert.rejects(f.main.startHost(),/cli-host-refused/);assert.ok(Date.now()-began<13_000);assert.equal(f.owner.processId(),undefined);release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.owner.processId(),undefined);assert.deepEqual((await readdir(f.captured().layout.cache)).filter(v=>v.startsWith('cli-')),[]);
});
