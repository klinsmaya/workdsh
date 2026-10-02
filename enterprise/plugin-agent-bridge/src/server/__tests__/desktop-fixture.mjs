import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBridge, digest } from '../core.ts';
import { EnterpriseMainSession } from '../../../../../dsh-plugin-desktop/src/enterprise-main.ts';
import { RefreshTokenVault } from '../../../../../dsh-plugin-desktop/src/desktop-auth.ts';
import { encodeModelSse } from '@afos/model-adapter';

// In-memory server/IdP replies, real PKCE loopback/Broker/Main/Recovery; no deployment acceptance.
export async function fixture(options={}) {
  const base=await mkdtemp(join(tmpdir(),'afos-main-flow-'));
  const issuer='https://enterprise.example/api';
  const config={contractVersion:'afos.desktop-config.v1',auth:{issuer,clientId:'desktop',resource:`${issuer}/afos`,scope:'afos offline_access'},releaseId:'fixed-release',policyRevision:'afos.policy.v1'};
  const evidence={issuer,principalId:'alice',clientId:'desktop',grantId:'grant',issuedAt:Date.now(),tokenId:'token',expiresAt:Date.now()+3600000};
  const project={id:'p1',organizationId:'org1',name:'Allowed'};
  const material={id:'m1',projectId:'p1',revisionId:'v1',name:'Source',text:'Server source',hash:digest('Server source')};
  const tables={runs:new Map(),uploads:new Map(),receipts:new Map(),artifacts:new Map(),commitRequests:new Map()};
  let active=true,connected=true,challenge='',stops=0,starts=0,refresh=0,capability={ingressValidated:false,sandbox:'unavailable'};
  let startHook=async()=>{},business;const calls=[];
  const store={tokenActive:async()=>active,deviceId:async()=>'device1',
    projects:async()=>({items:[project],nextPosition:null}),project:async(_,id)=>id===project.id?project:undefined,
    materials:async()=>({items:[material],nextPosition:null}),material:async(_,id,rev)=>id===material.id&&rev===material.revisionId?material:undefined,
    get:async(t,id)=>structuredClone(tables[t].get(id)),insert:async(t,v)=>{if(tables[t].has(v.id))throw Error('unique');tables[t].set(v.id,structuredClone(v));},replaceUpload:async v=>tables.uploads.set(v.id,structuredClone(v)),
    transaction:async fn=>fn(store),audit:async()=>{},};
  const bridge=new AgentBridge(store,config.releaseId,config.policyRevision,randomBytes(32),Boolean(options.model));
  const fetcher=async(url,init)=>{
    if(!connected)throw new TypeError('fixture disconnected');
    if(String(url).endsWith('openid-configuration'))return Response.json({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,code_challenge_methods_supported:['S256']});
    if(String(url)===`${issuer}/token`){
      const override=await options.tokenResponse?.(init);if(override)return override;
      const params=new URLSearchParams(String(init.body));
      assert.equal(params.has('client_secret'),false);
      if(params.get('grant_type')==='authorization_code')assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'),challenge);
      return Response.json({access_token:'fixture-access',refresh_token:`fixture-refresh-${++refresh}`,token_type:'Bearer',expires_in:options.shortTokens?1:3600,scope:'afos offline_access'});
    }
    assert.equal(String(url),`${issuer}/afos`);assert.equal(new Headers(init.headers).get('Authorization'),'Bearer fixture-access');
    const request=JSON.parse(init.body);calls.push(request.action);
    if(request.contractVersion==='afos.model.v1'&&options.model){
      await bridge.authorizeModel(evidence,request.run);
      const chunks=await options.model(request,init.signal);
      const body=new ReadableStream({async start(controller){try{for await(const chunk of chunks){init.signal.throwIfAborted();controller.enqueue(new TextEncoder().encode(encodeModelSse(chunk)));}controller.close();}catch(error){controller.error(error);}}});
      return new Response(body,{headers:{'content-type':'text/event-stream'}});
    }
    const override=await options.response?.(request,init.signal);if(override)return override;
    try{return Response.json(await bridge.dispatch(evidence,request.action,request.params));}
    catch(error){return Response.json({code:error.code??'afos/internal-error'},{status:error.status??503});}
  };
  const browser=async href=>{const auth=new URL(href);challenge=auth.searchParams.get('code_challenge');const callback=new URL(auth.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({state:auth.searchParams.get('state'),code:'fixture-code'}).toString();assert.equal((await fetch(callback)).status,200);};
  const vault=new RefreshTokenVault(join(base,'vault'),{available:()=>true,encrypt:text=>Buffer.from(text.split('').reverse().join('')),decrypt:data=>data.toString().split('').reverse().join('')});
  const host={stop:async()=>{stops++;await options.stopHost?.();},capabilities:async()=>capability,start:async(layout,authority,signal,callbacks)=>{starts++;business=callbacks;await startHook(signal,layout,authority,callbacks);}};
  const main=new EnterpriseMainSession(config,base,vault,host,browser,fetcher);
  const ready=async()=>{await main.signIn();return main.selectProject(project.id);};
  const ref={materialId:material.id,revisionId:material.revisionId,sha256:material.hash};
  const bind=async(runId,sessionId)=>{if(!business){capability={ingressValidated:true,sandbox:'full'};await main.startHost();}const lease=await business.prepareSessionBinding(runId,sessionId,new AbortController().signal);lease.commit();return lease;};
  return {main,base,config,tables,calls,ref,ready,host,vault,bind,business:()=>business,principal:value=>{evidence.principalId=value;},stops:()=>stops,starts:()=>starts,revoke:()=>{active=false;},disconnect:()=>{connected=false;},reconnect:()=>{connected=true;},capability:value=>{capability=value;},startHook:value=>{startHook=value;},cleanup:async()=>{await main.logout();await rm(base,{recursive:true,force:true});}};
}
