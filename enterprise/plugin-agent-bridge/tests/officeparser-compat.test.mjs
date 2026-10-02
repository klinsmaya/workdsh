import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {Worker} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const server=require.resolve('@nocobase/server/package.json'),ai=createRequire(server).resolve('@nocobase/ai/package.json');
const aiRequire=createRequire(ai),community=aiRequire.resolve('@langchain/community/package.json'),communityRequire=createRequire(community);
const officeEntry=communityRequire.resolve('officeparser'),officeRoot=resolve(dirname(officeEntry),'..'),office=communityRequire('officeparser');
const worker=resolve(dirname(ai),'lib/document-loader/loader.worker.js'),fixture=name=>resolve(root,'tests/fixtures',name);
const readJson=async path=>JSON.parse(await readFile(path,'utf8'));
async function loadWorker(name){const thread=new Worker(worker);try{return await new Promise((yes,no)=>{const timer=setTimeout(()=>no(new Error('Actual AI worker timed out')),25000);thread.once('error',e=>{clearTimeout(timer);no(e);});thread.once('message',response=>{clearTimeout(timer);yes(response);});thread.postMessage({filePath:fixture(name),extname:'.'+name.split('.').at(-1)});});}finally{await thread.terminate();}}
const matchAll=(text,values)=>{for(const value of values)assert.ok(text.includes(value),'Missing parsed content: '+value);};
const expected={
 'rich.docx':['AFOS document migration','enterprise evidence','中文材料','Budget','42','AFOS fixture'],
 'rich.xlsx':['Sheet: Budget','Revenue\t23.00','Total\t42','中文材料\tAFOS row','Sheet: Second','AFOS retention\t7'],
 'rich.pptx':['AFOS presentation migration','中文材料','Budget','42','AFOS fixture','AFOS speaker note preserved','AFOS second slide','Decision record 17','Second note'],
 'rich.pdf':['AFOS PDF migration page 1','AFOS PDF migration page 2','Enterprise evidence','Budget 42','Review record 17','Review record 18'],
};

test('The actual pinned NocoBase worker keeps DOCX/XLSX/PPTX/PDF document and metadata contracts',async()=>{
 assert.equal((await readJson(server)).version,'2.4.0-alpha.9');assert.equal((await readJson(ai)).version,'2.4.0-alpha.9');
 for(const name of Object.keys(expected)){
  const response=await loadWorker(name);assert.equal(response.error,undefined);assert.ok(response.documents?.length);matchAll(response.documents.map(d=>d.pageContent).join('\n'),expected[name]);
  for(const doc of response.documents){assert.equal(typeof doc.pageContent,'string');assert.equal(doc.metadata.source,fixture(name));assert.deepEqual(Object.keys(doc).sort(),['id','metadata','pageContent']);}
  assert.equal(response.documents.length,name.endsWith('.pdf')||name.endsWith('.xlsx')?2:1);
  if(name.endsWith('.xlsx')){assert.deepEqual(response.documents.map(d=>d.metadata.sheetName),['Budget','Second']);assert.deepEqual(response.documents.map(d=>d.metadata.sheetIndex),[0,1]);}
  if(name.endsWith('.pdf'))assert.deepEqual(response.documents.map(d=>d.metadata.loc.pageNumber),[1,2]);
 }
});

test('Both patched public PPTXLoader exports load real files and reject malformed input',async()=>{
 const metadata=await readJson(community),target=metadata.exports['./document_loaders/fs/pptx'];
 const cjs=communityRequire('@langchain/community/document_loaders/fs/pptx');
 const esm=await import(pathToFileURL(resolve(dirname(community),target.import.default)).href);
 for(const {PPTXLoader} of [cjs,esm]){
  const docs=await new PPTXLoader(fixture('rich.pptx')).load();assert.equal(docs.length,1);matchAll(docs[0].pageContent,expected['rich.pptx']);assert.equal(docs[0].metadata.source,fixture('rich.pptx'));
  await assert.rejects(()=>new PPTXLoader(fixture('corrupt.pptx')).load());
 }
});

test('The existing worker returns errors for corrupt containers and preserves empty handling',async()=>{
 for(const type of ['docx','xlsx','pptx','pdf']){const value=await loadWorker('corrupt.'+type);assert.equal(typeof value.error,'string');assert.ok(value.error.length);assert.equal(value.documents,undefined);}
 const empty=await loadWorker('empty.pptx');assert.equal(empty.error,undefined);assert.deepEqual(empty.documents.map(d=>d.pageContent),['1']);
});

test('OfficeParser8 public Node API parses all four rich formats with correct structured payloads',async()=>{
 assert.equal((await readJson(resolve(officeRoot,'package.json'))).version,'8.1.0');
 for(const name of Object.keys(expected)){
  const ast=await office.parseOffice(await readFile(fixture(name)),{onWarning:()=>{}});assert.equal(ast.toText,undefined);const output=await ast.to('text');assert.equal(typeof output.value,'string');
  const tokens=(name==='rich.xlsx'?['Revenue','23','Total','42','中文材料','AFOS row','AFOS retention','7']:expected[name]).map(v=>v.replaceAll('\t',' '));const normalized=output.value.replaceAll(/\s+/g,' ');matchAll(normalized,tokens);
  assert.ok(ast.content.length);assert.ok(ast.metadata);assert.ok(Array.isArray(output.messages));
 }
 for(const type of ['docx','xlsx','pptx','pdf'])await assert.rejects(async()=>office.parseOffice(await readFile(fixture('corrupt.'+type)),{onWarning:()=>{}}));
});

test('Actual locked consumer and browser artifacts contain PDF.js6.2.108; separate PDFLoader is explicit',async()=>{
 const metadata=await readJson(resolve(officeRoot,'package.json'));assert.equal(metadata.dependencies['pdfjs-dist'],'6.2.108');
 const local=createRequire(resolve(officeRoot,'package.json')),pdfPackage=await readJson(local.resolve('pdfjs-dist/package.json'));assert.equal(pdfPackage.version,'6.2.108');
 const lock=await readFile(resolve(root,'pnpm-lock.yaml'),'utf8');assert.match(lock,/officeparser@8\.1\.0/);assert.ok(!lock.includes('officeparser@6.1.1')&&!lock.includes('pdfjs-dist@5.6.205'));assert.match(lock,/patch_hash=/);
 for(const name of ['officeparser.browser.mjs','officeparser.browser.iife.js','officeparser.browser.native-pdf.mjs','officeparser.browser.slim.mjs','officeparser.browser.slim.iife.js']){
  const bytes=await readFile(resolve(officeRoot,'dist',name),'utf8');assert.ok(!bytes.includes('5.6.205'));if(!name.includes('.slim.'))assert.ok(bytes.includes('6.2.108'));
 }
 const pdf=communityRequire.resolve('pdf-parse/package.json');assert.equal((await readJson(pdf)).version,'1.1.4');
 const pdfRoute=await readFile(communityRequire.resolve('@langchain/community/document_loaders/fs/pdf'),'utf8');assert.ok(pdfRoute.includes('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js'));
});


test('Official shipped OfficeParser8 browser bundle parses real DOCX/XLSX/PPTX/PDF on two cold loads',async t=>{
 const tools=createRequire(process.env.AFOS_DOCUMENT_BROWSER_TOOLS || resolve(root,'../../workdsh-web/package.json'));
 const {chromium}=tools('@playwright/test');const browser=await chromium.launch({headless:true,executablePath:process.env.AFOS_TEST_CHROMIUM});
 t.diagnostic('Actual Chromium '+browser.version()+'; two independent contexts; official bundle and real PDF.js worker');
 const bundle=await readFile(resolve(officeRoot,'dist/officeparser.browser.mjs'),'utf8');const pdfRoot=dirname(createRequire(resolve(officeRoot,'package.json')).resolve('pdfjs-dist/package.json'));
 const pdfWorker=await readFile(resolve(pdfRoot,'build/pdf.worker.min.mjs'),'utf8');
 try{for(let cold=0;cold<2;cold++){
  const context=await browser.newContext();const blocked=[],errors=[];
  await context.route('**/*',async route=>{
   const url=new URL(route.request().url());
   if(url.origin!=='https://officeparser.test'){blocked.push(url.href);return route.abort();}
   if(url.pathname==='/office-parser.mjs')return route.fulfill({contentType:'text/javascript',body:bundle});
   if(url.pathname==='/pdf.worker.mjs')return route.fulfill({contentType:'text/javascript',body:pdfWorker});
   if(url.pathname==='/fixture')return route.fulfill({contentType:'text/html',body:'<!doctype html><div>Local document parser fixture</div>'});
   return route.fulfill({status:404,body:''});
  });
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto('https://officeparser.test/fixture');
  for(const name of Object.keys(expected)){
   const bytes=await readFile(fixture(name));const result=await page.evaluate(async ({data})=>{
    const op=await import('/office-parser.mjs');const warnings=[];const ast=await op.parseOffice(Uint8Array.from(data),{pdfWorkerSrc:'https://officeparser.test/pdf.worker.mjs',onWarning:issue=>warnings.push(issue.type)});
    const output=await ast.to('text');return{value:output.value,content:ast.content.length,metadata:!!ast.metadata,legacyToText:typeof ast.toText,scriptExecuted:globalThis.__AFOS_DOC_SCRIPT__===true,warnings};
   },{data:[...bytes]});
   t.diagnostic(JSON.stringify({cold,name,content:result.content,metadata:result.metadata,legacyToText:result.legacyToText,scriptExecuted:result.scriptExecuted,warnings:result.warnings}));
   const tokens=name==='rich.xlsx'?['Revenue','23','Total','42','中文材料','AFOS row','AFOS retention','7']:expected[name];matchAll(result.value.replaceAll(/\s+/g,' '),tokens.map(v=>v.replaceAll('\t',' ')));assert.ok(result.content);assert.ok(result.metadata);assert.equal(result.legacyToText,'undefined');assert.equal(result.scriptExecuted,false);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);await context.close();
 }}finally{await browser.close();}
});
