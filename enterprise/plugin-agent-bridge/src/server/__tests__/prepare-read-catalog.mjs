import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, cp, symlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// The cold Main map is a separately frozen author's external fixture input.
// It is deliberately absent from this product patch and the 7ba21b7 base.
const [sourceArg, outputArg, coldArg] = process.argv.slice(2);
if (!sourceArg || !outputArg || !coldArg || process.argv.length !== 5) throw Error('read catalog fixture arguments');
const source = resolve(sourceArg), output = resolve(outputArg), cold = resolve(coldArg);
await mkdir(output); const external = join(output, 'external-cold-main'); await mkdir(external);
const inputs=[];
for (const name of ['enterprise-main.ts','enterprise-recovery.ts']) {
  const original=join(cold,'dsh-plugin-desktop/src',name), copy=join(external,name);
  await cp(original,copy); const data=await readFile(copy);
  inputs.push({original,copy,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
const provider=join(source,'workdsh-web/packages/providers/enterprise-profile');
await symlink(await realpath(join(provider,'node_modules')),join(output,'node_modules'),'dir');
const require=createRequire(join(source,'workdsh-web/packages/plugins/enterprise-drafts/package.json'));
const {build}=require('esbuild'), fixture=join(source,'enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs');
await build({entryPoints:[join(dirname(fixture),'read-catalog.integration.mjs')],outfile:join(output,'test.mjs'),
  bundle:true,format:'esm',platform:'node',target:'node24',packages:'external',sourcemap:true,
  plugins:[{name:'frozen-cold-main-and-new-main-owner',setup(builder){
    builder.onResolve({filter:/\/enterprise-(main|recovery)\.ts$/},args=>({path:join(external,args.path.endsWith('enterprise-main.ts')?'enterprise-main.ts':'enterprise-recovery.ts')}));
    builder.onResolve({filter:/\/dist\/assembly\.js$/},()=>({path:join(provider,'dist/assembly.js'),external:true}));
    builder.onLoad({filter:/external-cold-main\/.*\.ts$/},async args=>({contents:await readFile(args.path,'utf8'),loader:'ts',resolveDir:join(source,'dsh-plugin-desktop/src')}));
    builder.onLoad({filter:/desktop-fixture\.mjs$/},async args=>{
      let contents=await readFile(args.path,'utf8');
      const replace=(from,to)=>{if(contents.split(from).length!==2)throw Error('original fixture drift');contents=contents.replace(from,to);};
      replace('const main=new EnterpriseMainSession','let main=new EnterpriseMainSession');
      replace("const base=await mkdtemp(join(tmpdir(),'afos-main-flow-'));","const base=options.base??await mkdtemp(join(tmpdir(),'afos-main-flow-'));");
      replace('await rm(base,{recursive:true,force:true});','if(!options.keepBase)await rm(base,{recursive:true,force:true});');
      replace('return {main,base,config,tables',`return {get main(){return main;},reopenMain:async(binding)=>{await main.suspend();main=new EnterpriseMainSession(config,base,vault,host,browser,fetcher);return main.restoreAccount(binding,project.id);},base,config,tables`);
      return {contents,loader:'js',resolveDir:dirname(args.path)};
    });
  }}]});
await writeFile(join(output,'PREPARATION.json'),JSON.stringify({source,output,cold,inputs,
  fixtureTransform:'four exact harness substitutions only: mutable Main owner, explicit suspend/new Main/restoreAccount, supplied existing base and keep-base child cleanup',
  providerDist:join(provider,'dist'),scope:'offline real Core, SQLite/JSONL, structural IdP/model; not final Root cold Main integration or AT'},null,2)+'\n');
console.log(JSON.stringify({output,inputFiles:inputs.length,scope:'external cold Main fixture only'}));
