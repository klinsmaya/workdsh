import type { Context } from '@deepseek-ai/cordis';
import { bootEnterpriseCore,bootEnterpriseNativeWsCore } from './assembly.js';
import { connectMainBusinessIpc, type MainIpcEndpoint } from './main-ipc.js';
/** Explicit optional private child bootstrap; public boot.prepare remains the service injection owner. */
export async function bootEnterpriseIpcCore(endpoint: MainIpcEndpoint, signal: AbortSignal): Promise<{readonly ctx:Context;close():Promise<void>}> {
  const channel = await connectMainBusinessIpc(endpoint, signal);
  let ctx:Context;
  try { const boot=channel.bootstrap.nativeCaller?bootEnterpriseNativeWsCore:bootEnterpriseCore;ctx = await boot({nativeCaller:channel.nativeCaller,root:channel.bootstrap.root, model:channel.bootstrap.model,
    binding:channel.authority.binding,projectId:channel.authority.project.id,business:channel.business,signal:channel.signal}); }
  catch(error) { channel.close(); throw error; }
  return Object.freeze({ctx,close:async()=>{channel.close();await ctx.fiber.dispose();}});
}
