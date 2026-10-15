import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {ProcessJob,recoverProcessJournal} from '../dev/compat-sdk/core/processes';
import {outputPath,readJson,withRecoveryLock} from '../dev/compat-sdk/core/files';
import {CompatibilityService,sealCompatibilityEvidence,validateCompatibilityEvidence} from '../src/main/compatibility';
import type {ProcessCompatibilityEvidence} from '../src/shared/compatibility';
import {processCaseVerdict} from '../dev/compat-sdk/core/process-verdict';

const target={fingerprint:'a'.repeat(64),gameBuild:'b'.repeat(64),managerBuild:'c'.repeat(64),components:{xxmi:'1.2.3'}};
const makeEvidence=()=>sealCompatibilityEvidence({schemaVersion:1,kind:'kmm-process-compatibility',scope:'restart-recovery',gameId:'zzz',managerVersion:'0.0.5',sourceDigest:'d'.repeat(64),runId:'test-run',testedAt:new Date().toISOString(),target,checks:{local:'passed',restart:'passed',recovery:'passed'},recoveryComplete:true,verdict:'passed'});
test('process verdict requires repeated controlled failures; flaky/uncontrolled/missing attempts stay inconclusive',()=>{
 const pass={status:'passed' as const,controlPassed:true,message:'ok'},fail={status:'failed' as const,controlPassed:true,message:'timeout'};
 assert.equal(processCaseVerdict([pass]),'passed');assert.equal(processCaseVerdict([fail,fail]),'failed');assert.equal(processCaseVerdict([fail,pass]),'inconclusive');assert.equal(processCaseVerdict([fail,{...fail,controlPassed:false}]),'inconclusive');assert.equal(processCaseVerdict([]),'inconclusive');
});
test('process evidence rejects corrupt, mis-scoped and contradictory records',()=>{
 const e=makeEvidence();assert.equal(validateCompatibilityEvidence(JSON.parse(JSON.stringify(e))).verdict,'passed');
 assert.throws(()=>validateCompatibilityEvidence({...e,digest:'f'.repeat(64)}));
 assert.throws(()=>validateCompatibilityEvidence({...e,scope:'full'}));
 assert.throws(()=>validateCompatibilityEvidence({...e,gameId:'unknown'}));
 assert.throws(()=>validateCompatibilityEvidence({...e,target:{...e.target,components:[]}}));
 assert.throws(()=>validateCompatibilityEvidence({...e,target:{...e.target,components:'invalid'}}));
 const {digest,...body}=e;assert.throws(()=>validateCompatibilityEvidence(sealCompatibilityEvidence({...body,recoveryComplete:false})));
 assert.equal(validateCompatibilityEvidence(sealCompatibilityEvidence({...body,checks:{...body.checks,recovery:'inconclusive'},verdict:'inconclusive'})).verdict,'inconclusive');
});
test('evidence import is per game, atomic, cancel-independent, and never launches or modifies Mod verification',async()=>{
 const root=outputPath('tests','evidence-'+randomUUID());await fs.mkdir(root,{recursive:true});const file=path.join(root,'input.json');await fs.writeFile(file,JSON.stringify(makeEvidence()));
 const service=new CompatibilityService(root,root,'0.0.5',async()=>({gameDirectory:'',xxmiRoot:'',modsDirectory:''}));
 await assert.rejects(()=>service.read('unknown' as 'zzz'),/不支持/);
 await assert.rejects(()=>service.import('endfield',file),/所属游戏/);assert.equal((await service.read('zzz')).state,'unknown');
 const result=await service.import('zzz',file);assert.equal(result.state,'unknown');assert.equal(result.evidence?.gameId,'zzz');
 const saved=await fs.readFile(path.join(root,'compatibility/zzz.json'),'utf8');await fs.writeFile(file,'{}');await assert.rejects(()=>service.import('zzz',file));assert.equal(await fs.readFile(path.join(root,'compatibility/zzz.json'),'utf8'),saved);
});

test('Windows owned kernel job: real child restart, crash recovery, preexisting guard and identity-safe cleanup',{skip:process.platform!=='win32',timeout:90000},async()=>{
 const directory=outputPath('tests','process-'+randomUUID());const ctrl=new AbortController();let job:ProcessJob|undefined;
 // A separate harmless process is never adopted or killed by this job.
 const outsider=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 try{
  job=await ProcessJob.create(directory);await assert.rejects(()=>job!.assertAbsent([process.execPath]),/已在运行|身份未确认/);
  const plan={executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:process.cwd()};
  await job.start({...plan,args:['-e',`require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)`]});const first=await job.waitForGame(process.execPath,ctrl.signal,5000,150);
  for(let i=0;i<50&&(await job.status()).length<2;i++)await delay(50);const tree=await job.status();assert.ok(tree.length>=2);
  await assert.rejects(()=>job!.request({action:'crash',pid:outsider.pid}),/not owned/);assert.equal(outsider.exitCode,null);
  await job.stop();assert.deepEqual(await job.status(),[]);for(const p of tree)assert.throws(()=>process.kill(p.pid,0));const journal=job.journal;assert.equal((await job.close()).complete,true);job=undefined;
  assert.equal((await readJson(journal) as {phase:string}).phase,'complete');assert.equal((await recoverProcessJournal(journal)).complete,true);
  job=await ProcessJob.create(directory);await job.start(plan);const second=await job.waitForGame(process.execPath,ctrl.signal,5000,150);assert.notEqual(second.pid,first.pid);
  await job.request({action:'crash',pid:second.pid});for(let i=0;i<50&&(await job.status()).length;i++)await delay(50);assert.deepEqual(await job.status(),[]);
  await job.close();job=await ProcessJob.create(directory);await job.start(plan);await job.waitForGame(process.execPath,ctrl.signal,5000,150);
  assert.equal((await recoverProcessJournal(job.journal)).complete,true);assert.deepEqual(await job.status(),[]);
  ctrl.abort();await assert.rejects(()=>job!.waitForGame(process.execPath,ctrl.signal,5000,150));assert.equal((await job.close()).complete,true);job=undefined;
  assert.equal(outsider.exitCode,null);process.kill(outsider.pid!,0);
 }finally{if(job)await job.close();outsider.kill();}
});

test('SDK owner hard-exit closes the job and durable recovery remains idempotent',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const directory=outputPath('tests','owner-exit-'+randomUUID());await fs.mkdir(directory,{recursive:true});const marker=path.join(directory,'ready.json');
 const script=path.join(directory,'owner.ts'),moduleFile=path.resolve('dev/compat-sdk/core/processes.ts'),lockModule=path.resolve('dev/compat-sdk/core/files.ts'),lockName='test-owner-'+randomUUID();
 await fs.writeFile(script,`import {ProcessJob} from ${JSON.stringify(moduleFile)};import {withLock} from ${JSON.stringify(lockModule)};import {promises as fs} from 'node:fs';withLock(${JSON.stringify(lockName)},async()=>{const j=await ProcessJob.create(${JSON.stringify(directory)});await j.start({executable:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:process.cwd()});const p=await j.waitForGame(process.execPath,new AbortController().signal,5000,150);await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({journal:j.journal,pid:p.pid}));await new Promise(()=>{});}).catch(e=>{console.error(e);process.exit(2)});`);
 const owner=spawn(process.execPath,['--import','tsx',script],{stdio:'ignore',windowsHide:true});let info:{journal:string;pid:number}|undefined;
 try{for(let i=0;i<200;i++){try{info=JSON.parse(await fs.readFile(marker,'utf8'));break;}catch{if(owner.exitCode!==null)throw new Error('owner exited '+owner.exitCode);await delay(100);}}assert.ok(info);owner.kill();
  for(let i=0;i<100;i++){try{process.kill(info.pid,0);}catch{break;}await delay(50);}
  assert.throws(()=>process.kill(info!.pid,0));assert.equal((await withRecoveryLock(()=>recoverProcessJournal(info!.journal),lockName)).complete,true);assert.equal((await readJson(info.journal) as {phase:string}).phase,'complete');
 }finally{owner.kill();if(info)await recoverProcessJournal(info.journal);}
});
