import {promises as fs} from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const parent=path.resolve('.run-data/update-network');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-'));
const driver=path.join(run,'native-probe.cjs');
await fs.writeFile(driver,`
const {app}=require('electron');
const fs=require('node:fs');const assert=require('node:assert/strict');const {createServer}=require('node:http');
const {fetchUpdate}=require(${JSON.stringify(path.resolve('dist/main/electron-update-fetch.js'))});
const state=value=>fs.writeFileSync(${JSON.stringify(path.join(run,'state.txt'))},value);state('driver started');
const fetch=(url,options={})=>fetchUpdate(url,{...options,signal:options.signal||AbortSignal.timeout(5000)});
app.setPath('userData',${JSON.stringify(path.join(run,'profile'))});
app.whenReady().then(async()=>{
 state('app ready');
 const outcomes=[];let hits=0;let accept='';const payload=Buffer.alloc(512*1024,97);
 const server=createServer((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{location:'/payload'});res.end();return;}
  if(req.url==='/payload'){hits++;accept=req.headers.accept;res.writeHead(200,{'content-type':'application/octet-stream','content-length':payload.length});res.end(payload);return;}
  if(req.url==='/slow'){res.writeHead(200,{'content-type':'application/octet-stream'});res.write(Buffer.alloc(64*1024));const timer=setInterval(()=>res.write('more'),20);res.on('close',()=>clearInterval(timer));return;}
  if(req.url==='/truncated'){res.writeHead(200,{'content-length':100});res.write('short');setTimeout(()=>res.socket.destroy(),20);return;}
  res.writeHead(503);res.end('unavailable');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 let pass=false,error;
 try{
  state('manual redirect');const redirect=await fetch(base+'/redirect',{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(new URL(redirect.headers.get('location'),base).pathname,'/payload');assert.equal(hits,0);outcomes.push('native Electron returns 302/Location without following or cancelling the promise');
  state('streamed response');const result=await fetch(new URL(redirect.headers.get('location'),base).href,{headers:{Accept:'application/vnd.github+json'}});assert.deepEqual(Buffer.from(await result.arrayBuffer()),payload);assert.equal(accept,'application/vnd.github+json');outcomes.push('caller follows validated hop; complete streamed bytes and request headers preserved');
  state('HTTP error');const unavailable=await fetch(base+'/unavailable');assert.equal(unavailable.status,503);await unavailable.body.cancel();
  state('early cancel');const canceled=new AbortController();canceled.abort(new Error('fixture cancelled'));await assert.rejects(fetch(base+'/payload',{signal:canceled.signal}),/fixture cancelled/);
  state('body abort headers');const abort=new AbortController();const abortTimer=setTimeout(()=>abort.abort(new Error('fixture abort during body')),2000);const slow=await fetch(base+'/slow',{signal:abort.signal});state('body abort reading');const body=slow.arrayBuffer();abort.abort(new Error('fixture abort during body'));state('body abort dispatched');clearTimeout(abortTimer);await assert.rejects(body,/fixture abort during body/);state('body abort rejected');
  state('truncated body');await assert.rejects((async()=>{const truncated=await fetch(base+'/truncated');await truncated.arrayBuffer();})());outcomes.push('HTTP failures remain visible; cancellation and truncated responses reject instead of completing partial files');
  pass=true;
 }catch(value){error=value.stack;state('failed: '+error);}
 finally{fs.writeFileSync(${JSON.stringify(path.join(run,'report.json'))},JSON.stringify({pass,outcomes,error},null,2));server.closeAllConnections();server.close();app.exit(pass?0:1);}
}).catch(error=>{fs.writeFileSync(${JSON.stringify(path.join(run,'report.json'))},JSON.stringify({pass:false,error:error.stack}));app.exit(1);});
`);
const env={...process.env};for(const key of ['ELECTRON_RUN_AS_NODE','KMM_DATA_DIR','KMM_DEV_URL','KMM_UPDATE_JOB'])delete env[key];
const child=spawn(require('electron'),[driver],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let diagnostics='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{diagnostics=(diagnostics+bytes).slice(-10000);});
const timer=setTimeout(()=>child.kill(),60000);const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});clearTimeout(timer);
let report;try{report=JSON.parse(await fs.readFile(path.join(run,'report.json'),'utf8'));}catch{report={pass:false,error:diagnostics};}
console.log(JSON.stringify({run,...report},null,2));if(code!==0||!report.pass)process.exitCode=1;
