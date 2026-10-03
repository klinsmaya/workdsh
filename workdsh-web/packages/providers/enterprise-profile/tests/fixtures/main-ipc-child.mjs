import { createInterface } from 'node:readline';
import { connectMainBusinessIpc } from '../../dist/main-ipc.js';
let wireGeneration;
const endpoint={send:message=>new Promise((resolve,reject)=>process.send(message,error=>error?reject(error):resolve())),messages:listener=>{const wrapped=value=>{if(value.kind==='welcome')wireGeneration=value.generation;listener(value);};process.on('message',wrapped);return()=>process.off('message',wrapped);},disconnected:listener=>{process.on('disconnect',listener);return()=>process.off('disconnect',listener);}};
const channel=await connectMainBusinessIpc(endpoint,new AbortController().signal);
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
output({ready:true,pid:process.pid,subject:channel.authority.binding.subject});
for await (const line of createInterface({input:process.stdin})) {
 const cmd=JSON.parse(line);let result;
 try {
  if(cmd.op==='lease'||cmd.op==='lease-no-release') {const lease=await channel.business.prepareSessionBinding('run-1','session-1',channel.signal);lease.commit();let gated=false;try{lease.assertReady();}catch{gated=true;}
    let ack,code;try{await lease.acknowledge(channel.signal);lease.assertReady();ack=true;}catch(e){ack=false;code=e.message;}let releaseCode;if(cmd.op!=='lease-no-release')try{await lease.release(channel.signal);}catch(e){releaseCode=e.message;}result={gated,ack,code,...(releaseCode?{releaseCode}:{})};}
  if(cmd.op==='two-pending'){result=await Promise.allSettled([channel.business.currentAuthority(channel.signal),channel.business.currentAuthority(channel.signal)]).then(values=>values.map(v=>({status:v.status,code:v.reason?.message})));}
  if(cmd.op==='cancel'){const controller=new AbortController();const action=channel.business.asyncAccess.refreshLocalState(controller.signal);setTimeout(()=>controller.abort(),20);result=await action.then(()=>({resolved:true}),e=>({code:e.message}));}
  if(cmd.op==='hold-prepare'){await channel.business.prepareSessionBinding('run-1','session-1',channel.signal);result={prepared:true};}
  if(cmd.op==='parallel-model'){const make=callId=>channel.business.modelBytes('session-1',{contractVersion:'afos.model.v1',run:{runId:'run-1',attempt:1},callId,request:{messages:[],maxTokens:100}},channel.signal)[Symbol.asyncIterator]();const iterators=[make('parallel-model-a'),make('parallel-model-b')];result=(await Promise.allSettled(iterators.map(iterator=>iterator.next()))).map(value=>({status:value.status,code:value.reason?.message}));await Promise.allSettled(iterators.map(iterator=>iterator.return()));}
  if(cmd.op==='model'){let sizes=[],code;const controller=new AbortController();if(cmd.cancel)setTimeout(()=>controller.abort(),20);try{for await(const value of channel.business.modelBytes('session-1',{contractVersion:'afos.model.v1',run:{runId:'run-1',attempt:1},callId:'model-1',request:{messages:[],maxTokens:100}},controller.signal))sizes.push(value.byteLength);}catch(e){code=e.message;}result={sizes,code};}
  if(cmd.op==='hold-lease'){const lease=await channel.business.prepareSessionBinding('run-1','session-1',channel.signal);lease.commit();await lease.acknowledge(channel.signal);result={held:true};}
  if(cmd.op==='invalid-wire'){process.send({contractVersion:'afos.main-ipc.v1',kind:'request',generation:wireGeneration,callId:999,method:cmd.unknown?'private.token':'state.refresh',args:cmd.unknown?{}:{actor:'forged'}});await new Promise(resolve=>setTimeout(resolve,30));result=await channel.business.asyncAccess.refreshLocalState(channel.signal).then(()=>({resolved:true}),e=>({code:e.message}));}
  if(cmd.op==='fake-stopped'){result=await channel.business.asyncAccess.markCancellation('session-1',true,channel.signal).then(()=>({resolved:true}),e=>({code:e.message}));}
  if(cmd.op==='state'){result=await channel.business.asyncAccess.refreshLocalState(channel.signal).then(()=>({resolved:true}),e=>({code:e.message}));}
  if(cmd.op==='exit'){channel.close();process.disconnect();process.exit(0);}
  output({op:cmd.op,result});
 }catch(error){output({op:cmd.op,error:error.message});}
}
