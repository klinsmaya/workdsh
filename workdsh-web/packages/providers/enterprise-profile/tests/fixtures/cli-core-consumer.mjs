import {createInterface} from 'node:readline';
import {writeSync} from 'node:fs';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
export const name='afos-cli-core-fixture';
export const inject=['afosCliCoreReady','workdshIdentity','afosDraftRuntime','agents','tools'];
export async function apply(ctx,config={}){
 const ready=ctx.afosCliCoreReady;ready.signal.throwIfAborted();
 let wakes=0,toolCalls=0,created=0,disposed=0;
 // Test-only root-lifetime public event counts survive private fixture disposal.
 const observe=event=>process.stdout.write('AFOS_OBSERVATION '+JSON.stringify({event,created,disposed,wakes,toolCalls,agents:created-disposed})+'\n');
 ctx.root.on('agent/created',()=>{created++;observe('agent/created');},{global:true});
 ctx.root.on('agent/disposed',()=>{disposed++;observe('agent/disposed');},{global:true});
 observe('ready');
 // Original CLI shutdown removes ctx.on listeners before Agent teardown settles.
 // Capture only the original public registry, then read list() synchronously at
 // Node exit; do not query disposed context services or infer a disposal event.
 const observedAgents=ctx.agents;
 process.once('exit',()=>{
  try{const agents=observedAgents.list().length;writeSync(1,'AFOS_OBSERVATION '+JSON.stringify({event:'process/exit',created,disposed,wakes,toolCalls,agents})+'\n');}
  catch{writeSync(1,'AFOS_OBSERVATION_UNAVAILABLE public-agent-list\n');}
 });
 if(config.wakeBeforeAck)ctx.on('agent/created',async({agent})=>{
  wakes++;observe('creation-wake');agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Creation wake must await Main ACK.'}]}));
  await new Promise(resolve=>setTimeout(resolve,20));
 },{global:true});
 ctx.root.on('session/event',(_session,event)=>{if(event.type==='tool/call'){toolCalls++;observe('tool/call');}},{global:true});
 const output=value=>process.stdout.write('AFOS_RESULT '+JSON.stringify(value)+'\n');
 const materials=await ready.business.materials(ready.signal);ready.signal.throwIfAborted();
 const rootLoader=ctx.root.get('loader'),owner=rootLoader?.locate(ctx.fiber);
 output({ready:true,core:true,pid:process.pid,ppid:process.ppid,
  originalLoader:owner!==undefined&&owner===ctx.get('loader').locate(ctx.fiber),entryOwner:owner,
  rootPrivate:ctx.root.get('afosMainBusiness')===undefined&&ctx.root.get('afosCliCoreReady')===undefined&&ctx.root.get('agents')===undefined,
  identity:ctx.workdshIdentity.binding.subject,materials,tools:ctx.tools.schemas().map(v=>v.name),agents:ctx.agents.list().length});
 // Test-only stdin controls. The product finite business IPC remains unchanged.
 ctx.effect(()=>{
  const lines=createInterface({input:process.stdin});let tail=Promise.resolve();
  lines.on('line',line=>{tail=tail.then(async()=>{
   const cmd=JSON.parse(line);try{
    let result;
    if(cmd.op==='invoke')result=await ctx.afosDraftRuntime.invoke('afos/drafts/'+cmd.method,cmd.payload??{},ready.signal);
    if(cmd.op==='idle'){const agent=ctx.agents.get(cmd.sessionId);await agent.whenIdle();await new Promise(resolve=>setTimeout(resolve,20));result={events:agent.session.snapshotEvents(),wakes,toolCalls};}
    if(cmd.op==='stats')result={wakes,toolCalls,agents:ctx.agents.list().length,identity:ctx.workdshIdentity.binding.subject};
    if(cmd.op==='unsafe-wire'){process.send(cmd.frame);result={sent:true};}
    output({op:cmd.op,result});
   }catch{output({op:cmd.op,error:'fixture-command-refused'});}
  });});return()=>lines.close();
 },'afos-cli-test-input');
}
