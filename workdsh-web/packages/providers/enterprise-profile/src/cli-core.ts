import type { Context } from '@deepseek-ai/cordis';
import { EnterpriseProfileError } from './snapshot-authority.js';
import type { CliBootstrap } from './cli-bootstrap.js';
import type {} from './cli-bootstrap.js';
export const name='afos-managed-cli-core-ready';
export const inject=['appReady','afosCliProfileReady','storage','storageDomain','tools','sessions','sessionProjections',
 'sessionPersistence','llm','systemPrompt','agents','agentLoop','skills','agentPresets','webServer',
 'credentials','connection','workdshIdentity','workdshAudit','workdshAccess','afosProfileAuthority',
 'afosProfileBridge','afosDraftRuntime','afosEnterpriseIngress'];
declare module '@deepseek-ai/cordis' { interface Context { afosCliCoreReady: CliBootstrap; } }
/** All Core implementations remain original fixed Loader entries in this scope. */
export function apply(ctx:Context):void {
 const ready=ctx.afosCliProfileReady;
 if(ready.nativeCaller&&(!ctx.get('afosNativeReadBridge')||!ctx.get('afosNativeHttpProof')||!ctx.get('afosCliNativeReady')))throw new EnterpriseProfileError('afos/cli-core-not-ready');ready.signal.throwIfAborted();
 for(const key of ['typertGateway','fs','mcp','bash','ptc','settings','sessionController']){
  if(ctx.get(key)!==undefined)throw new EnterpriseProfileError('afos/cli-core-not-ready');
 }
 ctx.provide('afosCliCoreReady',ready);
 const launcher=ctx.get('appReady');
 const exit=ctx.get('appExit');
 if(!launcher||typeof launcher.onReady!=='function'||typeof exit!=='function')throw new EnterpriseProfileError('afos/cli-core-not-ready');
 ctx.effect(()=>launcher.onReady(()=>{
  if(ready.signal.aborted)return;
  if(ready.online){
   const server=ctx.webServer;
   void ready.online.publishReady({host:'127.0.0.1',port:server.port,authenticatedUrl:ctx.connection.authenticatedUrl(`http://127.0.0.1:${server.port}/`)}).catch(()=>exit(1));
  }
  process.stdout.write('AFOS_CLI_READY v1\n');
 }), 'afos-original-cli-ready');
}
