import { createRequire } from 'node:module';
import { fixedEnterpriseCoreRows, type CoreRowOptions } from './core-rows.js';

/** Isolation is explicit for every business/Core service; true creates private labels. */
export const MANAGED_CLI_SCOPE_KEYS=Object.freeze([
  'afosMainBusiness','afosIdentityAuthority','afosCliBootstrap','afosCliProfileReady','afosCliCoreReady',
  'workdshIdentity','workdshAudit','workdshAccess','afosProfileAuthority','afosProfileBridge',
  'afosDraftRuntime','afosEnterpriseIngress','storage','storage.backend.json','storageDomain','tools','sessions',
  'sessionProjections','sessionPersistence','llm','systemPrompt','agents','agentLoop','skills',
  'agentPresets','webServer','credentials','connection','typertGateway','fs','mcp','bash','ptc',
  'settings','sessionController',
]);
/** Fixed zero-expression patch for an otherwise empty, Main-owned CLI Profile. */
export function managedCliProfilePatch(options:CoreRowOptions){
 const require=createRequire(import.meta.url);
 const identity=require.resolve('workdsh-provider-identity-nocobase');
 const domain=require.resolve('@deepseek-ai/dsh-storage-domain');
 const loop=require.resolve('@deepseek-ai/dsh-agent-loop');
 const core=fixedEnterpriseCoreRows(options).filter(row=>row.name!==identity)
  .map(row=>({...row,inject:['afosCliProfileReady',...(row.name===domain?['storage']:[]),
   ...(row.name===loop?['agents','sessions','llm','tools','systemPrompt','sessionProjections']:[])]}));
 return [{insert:[{id:'afos-private-cli',name:require.resolve('@deepseek-ai/cordis-plugin-group'),group:true,
  isolate:Object.fromEntries(MANAGED_CLI_SCOPE_KEYS.map(key=>[key,true])),config:[
   {id:'afos-cli-bootstrap',name:require.resolve('workdsh-provider-enterprise-profile/cli-bootstrap')},
   {id:'afos-cli-identity',name:require.resolve('workdsh-provider-enterprise-profile/cli-ready')},
   ...core,
   {id:'afos-cli-core',name:require.resolve('workdsh-provider-enterprise-profile/cli-core')},
  ]}]}];
}
