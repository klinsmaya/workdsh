import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, cp, symlink, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// This fixture consumes the actual Root29 product Main source in this worktree.
const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg || process.argv.length !== 4) throw Error('read catalog fixture arguments');
const source = resolve(sourceArg), output = resolve(outputArg);
await mkdir(output);
const provider=join(source,'workdsh-web/packages/providers/enterprise-profile');
await symlink(await realpath(join(provider,'node_modules')),join(output,'node_modules'),'dir');
const require=createRequire(join(source,'workdsh-web/packages/plugins/enterprise-drafts/package.json'));
const {build}=require('esbuild'), fixture=join(source,'enterprise/plugin-agent-bridge/src/server/__tests__/desktop-fixture.mjs');
await build({entryPoints:[join(dirname(fixture),'cold-retain.integration.mjs')],outfile:join(output,'test.mjs'),
  bundle:true,format:'esm',platform:'node',target:'node24',packages:'external',sourcemap:true,
  plugins:[{name:'frozen-cold-main-and-new-main-owner',setup(builder){
    builder.onResolve({filter:/\/dist\/(assembly|native-read-catalog|native-ws-facade)\.js$/},args=>({path:join(provider,'dist',args.path.split('/').at(-1)),external:true}));
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
await writeFile(join(output,'PREPARATION.json'),JSON.stringify({source,output,mainSource:join(source,'dsh-plugin-desktop/src/enterprise-main.ts'),
  fixtureTransform:'four exact harness substitutions only: mutable Main owner, explicit suspend/new Main/restoreAccount, supplied existing base and keep-base child cleanup',
  providerDist:join(provider,'dist'),scope:'offline actual own Root29 Main+Core/JSONL and structural IdP/model; not AT'},null,2)+'\n');
console.log(JSON.stringify({output,mainSource:'own Root29 product Main',scope:'cold retained Conversation component only'}));
