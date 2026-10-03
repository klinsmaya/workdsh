export const name='afos-private-test-caller-consumer';
export const inject=['afosCliCoreReady','afosCliNativeReady','connection','webServer'];
export function apply(ctx){
 const root=ctx.root;
 const url=new URL(ctx.connection.authenticatedUrl('http://127.0.0.1:'+ctx.webServer.port+'/'));let headers,status;
 ctx.connection.authorizeIndex({method:'GET',url:url.pathname+url.search,headers:{host:url.host}},{writeHead(s,h){status=s;headers=h;},end(){}});
 if(status!==303)throw Error('fixture original cookie unavailable');
 const cookie=headers['Set-Cookie']??headers['set-cookie'];
 process.stdout.write('AFOS_RESULT '+JSON.stringify({ready:true,pid:process.pid,authority:url.host,cookie:(Array.isArray(cookie)?cookie[0]:cookie).split(';')[0],rootPrivate:!root.get('afosMainBusiness')&&!root.get('afosNativeCallerProof')&&!root.get('afosNativeHttpProof')})+'\n');
}
