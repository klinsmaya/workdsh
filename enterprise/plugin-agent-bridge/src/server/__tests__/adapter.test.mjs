import assert from 'node:assert/strict';
import { test } from 'node:test';
import Plugin, {NocoBaseBridgeStore} from '../../../dist/server/plugin.js';

function adapter(overridePermission) {
  const writes=[];const reads=[];
  const app={
    db:{getRepository:name=>({
      create:async args=>writes.push({name,args}),
      findOne:async args=>{reads.push({name,args});return name==='users'?{get:key=>key==='id'?'alice':undefined}:null;},
      find:async args=>{reads.push({name,args});return name==='users.roles'?[{name:'member'}]:[];},
    })},
    acl:{resolveActionParams:async(_ctx,request)=>({mergedParams:overridePermission?overridePermission(request):request.params})},
  };
  return {store:new NocoBaseBridgeStore(app,{state:{currentUser:{get:key=>key==='id'?'alice':undefined},currentRoles:['member']}},'https://enterprise.example/api/afos'),writes,reads,app};
}
const artifact={id:'artifact1',projectId:'p1',runId:'run1',revisionId:'rev1',hash:'a'.repeat(64),content:'draft',sources:[],releaseId:'release1',status:'draft-needs-review'};

test('AFOS-CHECK-N01 adapter enforces artifact field whitelist before repository create',async()=>{
  const f=adapter(request=>({...request.params,whitelist:['id','projectId']}));
  await assert.rejects(f.store.insert('artifacts',artifact),/afos\/artifact-fields-denied/);
  assert.equal(f.writes.length,0);
  const allowed=adapter(request=>({...request.params,whitelist:['id','projectId','payload']}));
  await allowed.store.insert('artifacts',artifact);assert.equal(allowed.writes.length,1);assert.equal(allowed.writes[0].args.values.payload.content,'draft');
});

test('AFOS-CHECK-N02 server fixed values and unsupported create filters cannot be ignored',async()=>{
  for(const permission of [request=>({...request.params,values:{...request.params.values,projectId:'other'}}),request=>({...request.params,blacklist:['payload']}),request=>({...request.params,filter:{projectId:'other'}})]) {
    const f=adapter(permission);await assert.rejects(f.store.insert('artifacts',artifact),/afos\/artifact-fields-denied/);assert.equal(f.writes.length,0);
  }
});

test('AFOS-CHECK-N03 token access pair and token denylist are current server-owned state',async()=>{
  const f=adapter();let revoked=false;let active=true;
  f.app.pm={get:()=>({service:{resolveClient:async()=>({client_id:'desktop',scope:'afos',subject_type:'public',application_type:'native',token_endpoint_auth_method:'none',redirect_uris:['http://127.0.0.1/oauth/callback']}),runWithProviderContext:(_ctx,fn)=>fn()}})};
  f.app.db.getRepository=name=>({find:async()=>name==='users.roles'?[{name:'member'}]:[],findOne:async()=>name==='users'?{get:key=>key==='id'?'alice':undefined}:name==='oidcStates'?{get:key=>key==='payload'?{kind:'Grant',jti:'grant1',accountId:'alice',clientId:'desktop',exp:Date.now()/1000+3600,resources:{'https://enterprise.example/api/afos':'afos'}}:null}:name==='afosRevokedTokens'?(revoked?{}:null):active?{get:()=> '1700000000000'}:null});
  const evidence={principalId:'alice',clientId:'desktop',tokenId:'token',grantId:'grant1',expiresAt:Date.now()+10000,issuedAt:1800000000000};
  assert.equal(await f.store.tokenActive(evidence),true);revoked=true;assert.equal(await f.store.tokenActive(evidence),false);
  revoked=false;active=false;assert.equal(await f.store.tokenActive(evidence),false);
});

test('AFOS-CHECK-N04 gateway candidate denies generic API for header variants and query credentials',async()=>{
  const middlewares=[];
  const app={pm:{get:()=>({service:{registerResourceServer(){},unregisterResourceServer(){}}})},
    use:handler=>middlewares.push(handler),resourceManager:{define(){}},acl:{allow(){}}};
  const config={issuer:'https://enterprise.example/api',audience:'https://enterprise.example/api/afos',jwksUrl:'https://enterprise.example/api/jwks',clientIds:['desktop'],releaseId:'release',policyRevision:'policy1'};
  const plugin=new Plugin(app,{name:'agent-bridge',bridge:config});await plugin.load();
  const token=`x.${Buffer.from(JSON.stringify({iss:config.issuer,client_id:'desktop',scope:'afos'})).toString('base64url')}.x`;
  for(const options of [{header:`bEaReR   ${token}`,query:{}},{header:'',query:{token}},{header:`Bearer ${token}`,query:{token}}]){
    let next=false;const ctx={path:'/api/users',method:'POST',request:{body:{}},state:{},query:options.query,get:key=>key==='Authorization'?options.header:'',getBearerToken:()=>options.header?options.header.replace(/^Bearer\s+/iu,''):options.query.token};
    await middlewares[0](ctx,async()=>{next=true;});assert.equal(ctx.status,403);assert.equal(next,false);
  }
});

test('AFOS-CHECK-N05 current grant withdrawal and client removal deny a still-signed access token',async()=>{
  const f=adapter();let grantPresent=true;let clientPresent=true;let rejected={};let account='alice';let resource='afos';
  f.app.pm={get:()=>({service:{resolveClient:async()=>clientPresent?{client_id:'desktop',scope:'afos',application_type:'native',token_endpoint_auth_method:'none',redirect_uris:['http://127.0.0.1/oauth/callback']}:undefined,runWithProviderContext:(_ctx,fn)=>fn()}})};
  f.app.db.getRepository=name=>({find:async()=>name==='users.roles'?[{name:'member'}]:[],findOne:async args=>name==='users'?{get:key=>key==='id'?'alice':undefined}:name==='oidcStates'?args.filter.model==='Grant'&&grantPresent?{get:key=>key==='payload'?{kind:'Grant',jti:'grant1',accountId:account,clientId:'desktop',exp:Date.now()/1000+3600,resources:{'https://enterprise.example/api/afos':resource},rejected}:null}:null:name==='afosRevokedTokens'?null:{get:()=> '1700000000000'}});
  const evidence={principalId:'alice',clientId:'desktop',tokenId:'token',grantId:'grant1',expiresAt:Date.now()+10000,issuedAt:Date.now()};
  assert.equal(await f.store.tokenActive(evidence),true);
  grantPresent=false;assert.equal(await f.store.tokenActive(evidence),false);grantPresent=true;
  rejected={resources:{'https://enterprise.example/api/afos':'afos'}};assert.equal(await f.store.tokenActive(evidence),false);rejected={};
  clientPresent=false;assert.equal(await f.store.tokenActive(evidence),false);clientPresent=true;
  account='mallory';assert.equal(await f.store.tokenActive(evidence),false);account='alice';
  resource='offline_access';assert.equal(await f.store.tokenActive(evidence),false);
});

test('AFOS-CHECK-N06 registered native Client state is current, without permissive auth defaults',async()=>{
  const f=adapter();let client={client_id:'desktop',scope:'afos',application_type:'native',token_endpoint_auth_method:'none',redirect_uris:['http://127.0.0.1/oauth/callback']};let expiresAt=null;
  f.app.pm={get:()=>({service:{resolveClient:async()=>undefined,runWithProviderContext:(_ctx,fn)=>fn()}})};
  f.app.db.getRepository=name=>({find:async()=>name==='users.roles'?[{name:'member'}]:[],findOne:async args=>name==='users'?{get:key=>key==='id'?'alice':undefined}:name==='oidcStates'?args.filter.model==='Client'?{get:key=>key==='payload'?client:expiresAt}:{get:key=>key==='payload'?{kind:'Grant',jti:'grant1',accountId:'alice',clientId:'desktop',exp:Date.now()/1000+3600,resources:{'https://enterprise.example/api/afos':'afos'}}:null}:name==='afosRevokedTokens'?null:{get:()=> '1700000000000'}});
  const evidence={principalId:'alice',clientId:'desktop',tokenId:'token',grantId:'grant1',expiresAt:Date.now()+10000,issuedAt:Date.now()};
  assert.equal(await f.store.tokenActive(evidence),true);
  expiresAt=new Date(Date.now()-1000);assert.equal(await f.store.tokenActive(evidence),false);expiresAt=null;
  client={...client,token_endpoint_auth_method:undefined};assert.equal(await f.store.tokenActive(evidence),false);
});

test('AFOS-CHECK-N07 ordinary and bulk mutation hooks protect all immutable business revisions',async()=>{
  const hooks=new Map();const app={db:{collection(){},on:(name,callback)=>hooks.set(name,callback)}};
  const plugin=new Plugin(app,{name:'agent-bridge'});await plugin.beforeLoad();
  for(const name of ['afosMaterials','afosArtifacts','afosReceipts'])for(const kind of ['beforeUpdate','beforeBulkUpdate','beforeDestroy','beforeBulkDestroy'])assert.throws(hooks.get(`${name}.${kind}`),/afos\/immutable-record/);
  assert.equal(hooks.size,12);
});

test('AFOS-CHECK-N08 generic and associated APIs cannot fabricate private bridge state with ordinary auth',async()=>{
  const middlewares=[];const definitions=[];
  const app={pm:{get:()=>({service:{registerResourceServer(){},unregisterResourceServer(){}}})},use:handler=>middlewares.push(handler),resourceManager:{options:{prefix:'/api'},define:options=>definitions.push(options)},acl:{allow(){}}};
  const config={issuer:'https://enterprise.example/api',audience:'https://enterprise.example/api/afos',jwksUrl:'https://enterprise.example/api/jwks',clientIds:['desktop'],releaseId:'release',policyRevision:'policy1'};
  const plugin=new Plugin(app,{name:'agent-bridge',bridge:config});await plugin.load();
  for(const path of ['/api/afosRuns:create','/api/afosReceipts','/api/afosArtifacts:update','/api/projects/p1/afosUploads','/api/afosRuns/one/anything','/resourcer/afosReceipts:create']){
    let next=false;const ctx={path,method:'POST',request:{body:{}},state:{},query:{},get:()=>''};
    await middlewares[0](ctx,async()=>{next=true;});assert.equal(ctx.status,403);assert.equal(ctx.body.code,'afos/private-resource');assert.equal(next,false);
  }
  assert.ok(definitions.filter(item=>item.name!=='afos').every(item=>item.only.length===1&&item.only[0]==='afosPrivateDenied'));
  await plugin.afterDisable();
  let next=false;const ctx={path:'/api/afos',method:'GET',request:{},state:{},query:{},get:()=> 'Bearer fixture'};
  await middlewares[0](ctx,async()=>{next=true;});assert.equal(ctx.status,403);assert.equal(next,false);
});

test('AFOS-CHECK-N09 project and material pages bound repository work before ACL filtering',async()=>{
  const f=adapter(request=>({...request.params,limit:99999}));
  const row=values=>({get:key=>values[key],toJSON:()=>values});
  const reads=[];
  f.app.db.getRepository=name=>({findOne:async()=>name==='users'?row({id:'alice'}):null,find:async args=>{
    reads.push({name,args});
    if(name==='users.roles')return [{name:'member'}];
    if(name==='afosProjectMembers')return Array.from({length:51},(_,i)=>row({id:`member${String(i).padStart(3,'0')}`,principalId:'alice',projectId:'p1',organizationId:'org1'}));
    if(name==='afosProjects')return [row({id:'p1',organizationId:'org1',name:'P1'})];
    if(name==='afosMaterials')return Array.from({length:51},(_,i)=>row({id:`material${String(i).padStart(3,'0')}`,projectId:'p1',revisionId:'v1',hash:'a'.repeat(64),name:'M'}));
    return [];
  }});
  const projects=await f.store.projects({principalId:'alice'},'member-before');
  assert.equal(projects.items.length,1);assert.equal(projects.nextPosition,'member049');
  assert.equal(reads[0].args.limit,51);assert.deepEqual(reads[0].args.filter.id,{$gt:'member-before'});
  assert.equal(reads.find(r=>r.name==='afosProjects').args.limit,50);
  const materials=await f.store.materials({principalId:'alice'},'p1','material-before');
  assert.equal(materials.items.length,50);assert.equal(materials.nextPosition,'material049');
  assert.equal(reads.at(-1).args.limit,51);assert.deepEqual(reads.at(-1).args.filter.id,{$gt:'material-before'});
});


test('AFOS-CHECK-N10 uncached native role removal stops an existing request and attached roles fail closed',async()=>{
  const f=adapter();let roles=[{name:'member'}];const repository=f.app.db.getRepository;
  f.app.db.getRepository=(name,id)=>name==='users.roles'?{find:async()=>roles}:repository(name,id);
  await f.store.insert('artifacts',artifact);assert.equal(f.writes.length,1);
  roles=[];await assert.rejects(f.store.insert('artifacts',artifact),/afos\/current-role-revoked/);assert.equal(f.writes.length,1);
  roles=[{name:'member'}];f.store.ctx.state.attachRoles=[{name:'department'}];
  await assert.rejects(f.store.insert('artifacts',artifact),/afos\/current-role-unavailable/);
});
