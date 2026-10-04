import {createInterface} from 'node:readline';
export const name='afos-private-test-caller-consumer';
export const inject=['afosCliCoreReady','afosCliNativeReady','connection','webServer','agents','sessions','tools'];
export function apply(ctx){
 const observed={created:0,disposed:0,toolCalls:0,preExecute:0,execute:0,results:0};
 ctx.on('agent/created',()=>{observed.created++;},{global:true});
 ctx.on('agent/disposed',()=>{observed.disposed++;},{global:true});
 ctx.on('session/event',(_session,event)=>{if(event.type==='tool/call')observed.toolCalls++;},{global:true});
 ctx.on('tools/pre-execute',async(_exec,next)=>{observed.preExecute++;return next();},{global:true,prepend:true});
 ctx.on('tools/execute',async(_exec,next)=>{observed.execute++;return next();},{global:true,prepend:true});
 ctx.on('tools/result',()=>{observed.results++;},{global:true});
 // Trusted opt-in test observer only; never send statistics over the strict business IPC.
 ctx.effect(()=>{
  const lines=createInterface({input:process.stdin});
  lines.on('line',line=>{
   if(Buffer.byteLength(line)>1024)return;
   let request;try{request=JSON.parse(line);}catch{return;}
   if(!request||request.op!=='at23-stats'||!Number.isSafeInteger(request.requestId)||request.requestId<1||Object.keys(request).length!==2)return;
   process.stdout.write('AFOS_AT23_STATS '+JSON.stringify({requestId:request.requestId,
    value:{...observed,agents:ctx.agents.list().length,sessions:ctx.sessions.list().length}})+'\n');
  });
  return()=>lines.close();
 });
 const root=ctx.root;
 const url=new URL(ctx.connection.authenticatedUrl('http://127.0.0.1:'+ctx.webServer.port+'/'));let headers,status;
 ctx.connection.authorizeIndex({method:'GET',url:url.pathname+url.search,headers:{host:url.host}},{writeHead(s,h){status=s;headers=h;},end(){}});
 if(status!==303)throw Error('fixture original cookie unavailable');
 const cookie=headers['Set-Cookie']??headers['set-cookie'];
 process.stdout.write('AFOS_RESULT '+JSON.stringify({ready:true,pid:process.pid,authority:url.host,cookie:(Array.isArray(cookie)?cookie[0]:cookie).split(';')[0],rootPrivate:!root.get('afosMainBusiness')&&!root.get('afosNativeCallerProof')&&!root.get('afosNativeHttpProof')})+'\n');
}
