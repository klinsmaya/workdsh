import { createInterface } from 'node:readline';
import { bootEnterpriseIpcCore } from '../../dist/ipc-assembly.js';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
const endpoint={send:message=>new Promise((resolve,reject)=>process.send(message,error=>error?reject(error):resolve())),messages:listener=>{process.on('message',listener);return()=>process.off('message',listener);},disconnected:listener=>{process.on('disconnect',listener);return()=>process.off('disconnect',listener);}};
const host=await bootEnterpriseIpcCore(endpoint,new AbortController().signal),ctx=host.ctx;
const output=value=>process.stdout.write('AFOS_RESULT '+JSON.stringify(value)+'\n');
let wakes=0,events=0;
if(process.argv.includes('--wake-before-ack'))ctx.on('agent/created',async({agent})=>{wakes++;agent.followup(createUserMessage({source:{kind:'user'},content:[{type:'text',text:'Creation listener wake before Main ACK must fail closed.'}]}));await new Promise(resolve=>setTimeout(resolve,20));},{global:true});
ctx.on('session/event',(_session,event)=>{if(event.type==='tool/call')events++;});
output({ready:true,pid:process.pid});
for await(const line of createInterface({input:process.stdin})){
 const cmd=JSON.parse(line);
 try{
  let result;
  if(cmd.op==='invoke')result=await ctx.afosDraftRuntime.invoke('afos/drafts/'+cmd.method,cmd.payload??{},new AbortController().signal);
  if(cmd.op==='idle'){const agent=ctx.agents.get(cmd.sessionId);await agent.whenIdle();await new Promise(resolve=>setTimeout(resolve,20));result={events:agent.session.snapshotEvents(),wakes,toolCalls:events};}
  if(cmd.op==='late-cancel'){await ctx.afosMainBusiness.asyncAccess.markCancellation(cmd.sessionId,false,new AbortController().signal);result={execution:ctx.afosMainBusiness.drafts().find(v=>v.sessionId===cmd.sessionId).localExecution};}
  if(cmd.op==='stats')result={wakes,toolCalls:events,agents:ctx.agents.list().length};
  if(cmd.op==='exit'){await host.close();process.disconnect();process.exit(0);}
  output({op:cmd.op,result});
 }catch(error){output({op:cmd.op,error:error.message});}
}
