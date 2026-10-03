import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { EnterpriseProfileError } from './snapshot-authority.js';
import { fixedNativeLoaderRows } from './native-loader-rows.js';
import { fixedEnterpriseCoreRows, type CoreRowOptions } from './core-rows.js';

/** Isolation is explicit for every business/Core service; true creates private labels. */
export const MANAGED_CLI_SCOPE_KEYS=Object.freeze([
  'afosMainBusiness','afosIdentityAuthority','afosCliBootstrap','afosCliProfileReady','afosCliCoreReady',
  'workdshIdentity','workdshAudit','workdshAccess','afosProfileAuthority','afosProfileBridge',
  'afosDraftRuntime','afosEnterpriseIngress','storage','storage.backend.json','storageDomain','tools','sessions',
  'sessionProjections','sessionPersistence','llm','systemPrompt','agents','agentLoop','skills',
  'agentPresets','webServer','credentials','connection','typertGateway','fs','mcp','bash','ptc',
  'settings','sessionController','afosNativeCallerProof','afosNativeAssemblyCapture','afosNativeParentWebServer','afosNativeParentConnection','afosNativePrivateController','afosNativePrivateReader','afosNativeReadBridge','afosNativeHttpProof',
]);
/** Fixed zero-expression patch for an otherwise empty, Main-owned CLI Profile. */
export function managedCliProfilePatch(options:CoreRowOptions){
 if(options.frontendIndex!==undefined&&(!options.nativeCaller||!isAbsolute(options.frontendIndex)||/[\u0000-\u001f\u007f]/u.test(options.frontendIndex)))throw new EnterpriseProfileError('afos/cli-bootstrap-refused');
 const require=createRequire(import.meta.url);
 const frontendRequire=options.frontendIndex?createRequire(createRequire(require.resolve('@deepseek-ai/dsh/package.json')).resolve('@deepseek-ai/dsh-web-app/package.json')):undefined;
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
   ...(options.nativeCaller?[{id:'afos-cli-native-owner',name:require.resolve('workdsh-provider-enterprise-profile/cli-native-owner')},...fixedNativeLoaderRows(options,true).map(row=>({...row,inject:['afosCliProfileReady']}))]:[]),
   ...(options.frontendIndex?[{id:'afos-cli-online-static',name:frontendRequire!.resolve('@deepseek-ai/dsh-host-frontend-static'),inject:['afosCliProfileReady'],config:{distIndex:options.frontendIndex}}]:[]),
   {id:'afos-cli-core',name:require.resolve('workdsh-provider-enterprise-profile/cli-core'),...(options.nativeCaller?{inject:['afosNativeReadBridge','afosNativeHttpProof','afosNativeCallerProof','afosCliNativeReady']}:{})},
  ]}]}];
}
