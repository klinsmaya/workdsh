import {connectMainBusinessIpc} from '../../dist/main-ipc.js';
import {createInterface} from 'node:readline';
let welcome;
const endpoint={send:message=>new Promise((resolve,reject)=>process.send(message,e=>e?reject(e):resolve())),messages:listener=>{const accept=message=>{if(message.kind==='welcome')welcome=message;listener(message);};process.on('message',accept);return()=>process.off('message',accept);},disconnected:listener=>{process.on('disconnect',listener);return()=>process.off('disconnect',listener);}};
const channel=await connectMainBusinessIpc(endpoint,new AbortController().signal);
console.log(JSON.stringify({bound:true,online:!!channel.bootstrap.online}));
const ready={host:'127.0.0.1',port:27890,authenticatedUrl:'http://127.0.0.1:27890/?token='+'A'.repeat(32)};
createInterface({input:process.stdin}).on('line',async line=>{const {op}=JSON.parse(line);try{
 if(op==='core-only')await channel.publishCoreReady();
 else if(op==='normal')await channel.publishReady(ready);
 else await endpoint.send({contractVersion:welcome.contractVersion,kind:'ready',generation:op==='wrong-generation'?'old-generation':welcome.generation,nonce:op==='wrong-nonce'?'B'.repeat(36):welcome.bootstrap.online.nonce,ready:op==='wrong-host'?{...ready,host:'localhost'}:op==='extra'?{...ready,token:'forged'}:ready});
 console.log(JSON.stringify({sent:op}));
}catch{console.log(JSON.stringify({refused:op}));}});
