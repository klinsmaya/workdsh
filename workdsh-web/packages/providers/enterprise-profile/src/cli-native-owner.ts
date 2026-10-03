import type { Context } from '@deepseek-ai/cordis';
import type { NativeAssemblyCaptures } from './native-captures.js';
import type {} from './cli-bootstrap.js';
import type {} from './native-ws-bridge.js';
import type {} from './native-ws-admission.js';
import type {} from './native-ws-connection.js';
import { EnterpriseProfileError } from './snapshot-authority.js';
export const name='afos-managed-cli-native-owner';
export const inject=['afosCliProfileReady','afosCliBootstrap','connection','webServer'];
declare module '@deepseek-ai/cordis' { interface Context { afosCliNativeReady: true } }
/** Finite Main proof and exact original Loader capture ownership in the already running CLI scope. */
export function apply(ctx:Context):void {
 const ready=ctx.afosCliBootstrap;ready.signal.throwIfAborted();if(!ready.nativeCaller)throw new EnterpriseProfileError('afos/native-read-denied');
 let controller=false,reader=false,mux=false;
 ctx.provide('afosNativeCallerProof',ready.nativeCaller);
 ctx.provide('afosNativeParentConnection',ctx.connection);ctx.provide('afosNativeParentWebServer',ctx.webServer);
 const captures:NativeAssemblyCaptures={
  controller(value){if(controller)throw new EnterpriseProfileError('afos/native-read-denied');controller=true;ctx.provide('afosNativePrivateController',value);},
  reader(value){if(reader)throw new EnterpriseProfileError('afos/native-read-denied');reader=true;ctx.provide('afosNativePrivateReader',value);},
  mux(value){if(mux||value.get('connection')?.operator!==ctx.connection.operator||value.get('webServer')===ctx.webServer)throw new EnterpriseProfileError('afos/native-read-denied');mux=true;ctx.provide('afosCliNativeReady',true);},
 };
 ctx.provide('afosNativeAssemblyCapture',captures);
}
