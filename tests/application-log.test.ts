import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ApplicationLog,logContext,useApplicationLog} from '../src/main/application-log';
import {OperationLog,logOperationReference} from '../src/main/operation-log';
import {ReadJobs} from '../src/main/read-jobs';

async function fixture(){const parent=path.resolve('.run-data/application-log-tests');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'run-'));const options={installDirectory:path.join(root,'install'),dataDirectory:path.join(root,'data'),version:'0.0.5'};return {root,options};}
const file=(logger:ApplicationLog)=>path.join(logger.directory,'application-'+logger.profileId+'.jsonl');
test('unified aspect logs reads, writes, nested traces, concurrency and backup references without arguments or secrets',async()=>{
 const f=await fixture(),logger=await ApplicationLog.open(f.options),operations=new OperationLog(f.options.dataDirectory,logger),reference=randomUUID(),parent=randomUUID();
 await logContext.run({operationId:parent,action:'request'},()=>operations.run('mods:scan',['zzz',{cookie:'DO_NOT_LOG'}],async()=>{
  await operations.run('mods:delete',['zzz',randomUUID()],async()=>{await logOperationReference(f.options.dataDirectory,'zzz','backup',reference);return null;});return {mods:[]};
 }));
 const failure=Object.assign(new Error('token=DO_NOT_LOG https://example.test/?secret=DO_NOT_LOG '+path.join(f.options.installDirectory,'dist/main/index.js:9:2')),{code:'ENOSPC'});
 await assert.rejects(operations.run('ini:save',['endfield'],async()=>{throw failure;}),error=>error===failure);
 await Promise.all(Array.from({length:20},(_,i)=>operations.run('settings:read',[],async()=>i)));
 const rows=(await logger.recentRows()).rows,scan=rows.find(row=>row.action==='mods:scan'&&row.phase==='start')!,remove=rows.find(row=>row.action==='mods:delete'&&row.phase==='finish')!;
 assert.equal(scan.parentOperationId,parent);assert.equal(remove.parentOperationId,scan.operationId);assert.ok(remove.referenceIds.includes(reference));assert.equal(rows.filter(row=>row.action==='settings:read'&&row.phase==='finish').length,20);
 const failed=rows.find(row=>row.action==='ini:save'&&row.phase==='finish')!;assert.equal(failed.error!.code,'ENOSPC');assert.ok(failed.error!.stack);assert.equal((await logger.report('endfield')).findings.some(f=>f.kind==='disk-full'),true);
 const rendererStack='Error: Controlled\n at file:///'+f.options.installDirectory.replace(/\\/g,'/')+'/dist/renderer/source.js:4:9';await logger.record('renderer','renderer.error',{},'error',Object.assign(new Error('Controlled'),{stack:rendererStack}));assert.ok((await fs.readFile(file(logger),'utf8')).includes('[install]/dist/renderer/source.js:4:9'));
 const text=await fs.readFile(file(logger),'utf8');assert.ok(!text.includes('DO_NOT_LOG'));assert.ok(!text.includes('https://'));assert.ok(text.includes('[install]'));
 await logger.close();
});
test('background conflict jobs keep the initiating operation link and distinguish candidates from confirmed game faults',async()=>{
 const f=await fixture(),logger=await ApplicationLog.open(f.options),operations=new OperationLog(f.options.dataDirectory,logger);useApplicationLog(logger);
 try{const jobs=new ReadJobs(async()=> 'stable');const job=await operations.run('inspection:conflicts',['zzz'],()=>jobs.start('conflicts','zzz',{xxmiRoot:'',gameDirectory:'',modsDirectory:f.root},async()=>({kind:'conflicts',gameId:'zzz',resultId:randomUUID(),groups:[{id:'group',type:'texture',hash:'abcd1234',modIds:[randomUUID(),randomUUID()],occurrenceCount:2}],warnings:[],scannedMods:2,scannedFiles:2,complete:true})));
  for(let i=0;i<100&&(await jobs.read(job.id)).stage==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
  const rows=(await logger.recentRows()).rows,observed=rows.find(row=>row.event==='conflicts.observed')!,started=rows.find(row=>row.action==='inspection:conflicts'&&row.phase==='start')!;
  assert.equal(observed.operationId,started.operationId);assert.equal(observed.jobId,job.id);const finding=(await logger.report('zzz')).findings.find(f=>f.kind==='mod-conflict-candidates');assert.ok(finding);assert.match(finding.explanation,/不能直接认定/);assert.equal((await logger.report('endfield')).findings.some(f=>f.kind==='mod-conflict-candidates'),false);
 }finally{useApplicationLog(undefined);await logger.close();}
});
test('real child fatal and abnormal exits leave durable evidence; clean exits never create a new abnormal-exit finding',async()=>{
 for(const mode of ['hard','fatal','clean']){
  const f=await fixture();let code=0;try{await promisify(execFile)(process.execPath,['--import','tsx','tests/fixtures/logging-exit.ts',f.root,mode],{cwd:process.cwd(),windowsHide:true,timeout:20000});}catch(error){code=Number((error as NodeJS.ErrnoException).code);}
  assert.equal(code,mode==='hard'?17:mode==='fatal'?1:0);
  const logger=await ApplicationLog.open(f.options),report=await logger.report('zzz');
  assert.equal(report.findings.some(f=>f.kind==='abnormal-exit'),mode==='hard');assert.equal(report.findings.some(f=>f.kind==='fatal'),mode==='fatal');assert.equal(report.findings.some(f=>f.kind==='unfinished-operation'),mode!=='clean');
  if(mode==='fatal')assert.ok((await logger.recentRows()).rows.some(row=>row.event==='process.uncaught-exception'&&row.error?.stack?.includes('Controlled fatal fixture')));
  await logger.close();
 }
});
test('rotation, oversized entries and partial final lines stay bounded and future records remain readable',async()=>{
 const f=await fixture(),logger=await ApplicationLog.open(f.options),target=file(logger),limit=4*1024**2;
 await logger.flush();await fs.writeFile(target,'x'.repeat(limit-1)+'\n');for(let index=1;index<=5;index++)await fs.writeFile(target+'.'+index,'archive '+index);
 await logger.record('test','rotation.check',{});assert.equal((await fs.stat(target+'.1')).size,limit);assert.equal(await fs.readFile(target+'.5','utf8'),'archive 4');
 await logger.record('test','bounded.check',Object.fromEntries(Array.from({length:60},(_,i)=>['field'+i,'x'.repeat(6000)])));assert.ok((await fs.readFile(target,'utf8')).split('\n').filter(Boolean).every(line=>Buffer.byteLength(line)<=32*1024));
 await fs.appendFile(target,'{"partial":');await logger.record('test','after.partial',{});const sample=await logger.recentRows();assert.ok(sample.malformedLines>0);assert.ok(sample.rows.some(row=>row.event==='after.partial'));
 await logger.close();
});
test('log write failure does not change business results or thrown identities; fallback is explicit',async()=>{
 const f=await fixture();await fs.mkdir(f.options.installDirectory,{recursive:true});await fs.writeFile(path.join(f.options.installDirectory,'log'),'occupied path');
 const logger=await ApplicationLog.open(f.options);assert.equal(logger.directory,path.join(f.options.dataDirectory,'log'));assert.equal((await logger.report('zzz')).fallback,true);
 const operations=new OperationLog(f.options.dataDirectory,logger),append=fs.appendFile;fs.appendFile=async(target,...args)=>{if(String(target)===file(logger))throw Object.assign(new Error('Controlled full log disk'),{code:'ENOSPC'});return (append as any)(target,...args);};
 try{assert.equal(await operations.run('mods:operate',['zzz'],async()=>42),42);const error=new Error('Business error');await assert.rejects(operations.run('mods:delete',['zzz'],async()=>{throw error;}),e=>e===error);const report=await logger.report('zzz');assert.equal(report.writable,false);assert.ok(report.writeFailures>0);}finally{fs.appendFile=append;await logger.close();}
 assert.equal(await fs.readFile(path.join(f.options.installDirectory,'log'),'utf8'),'occupied path');
});
test('profiles use separate writers, and malformed report fields cannot crash log analysis',async()=>{
 const f=await fixture(),logger=await ApplicationLog.open(f.options),other=await ApplicationLog.open({...f.options,dataDirectory:path.join(f.root,'other-profile')});assert.notEqual(file(logger),file(other));
 await other.record('test','other.profile',{},'error',new Error('Other profile only'));
 await fs.appendFile(file(logger),JSON.stringify({schemaVersion:2,time:new Date().toISOString(),sessionId:logger.sessionId,component:'test',level:'error',event:'malformed.fields',error:{message:{invalid:true},code:[]},result:{failureCategories:4}})+'\n');
 const report=await logger.report('zzz');assert.ok(!report.recent.some(row=>row.message?.includes('Other profile only')));await logger.close();await other.close();
});
