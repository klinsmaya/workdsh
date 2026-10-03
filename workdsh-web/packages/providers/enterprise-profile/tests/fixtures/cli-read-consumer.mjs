export const name='afos-cli-read-fixture';
export const inject=['afosCliProfileReady','workdshIdentity'];
export async function apply(ctx){
 const ready=ctx.afosCliProfileReady;
 ready.signal.throwIfAborted();
 const materials=await ready.business.materials(ready.signal);
 ready.signal.throwIfAborted();
 const rootLoader=ctx.root.get('loader'),owner=rootLoader?.locate(ctx.fiber);
 process.stdout.write('AFOS_RESULT '+JSON.stringify({ready:true,pid:process.pid,ppid:process.ppid,
  originalLoader:owner!==undefined&&owner===ctx.get('loader').locate(ctx.fiber),entryOwner:owner,rootPrivate:ctx.root.get('afosMainBusiness')===undefined&&ctx.root.get('afosCliProfileReady')===undefined,
  identity:ctx.workdshIdentity.binding.subject,materials})+'\n');
}
