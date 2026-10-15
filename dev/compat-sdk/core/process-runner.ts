import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import type {GameId,GamePaths} from '../../../src/shared/contracts';
import type {ProcessCompatibilityEvidence,ProcessCheckStatus} from '../../../src/shared/compatibility';
import {probeCompatibilityTarget,sealCompatibilityEvidence} from '../../../src/main/compatibility';
import {stableContext} from '../adapters/context';
import {createRunner} from './runner';
import {registerLocalSuites} from '../suites/local';
import {OUTPUT,REPO,outputPath,saveJson,sha,withLock} from './files';
import {pendingRecovery} from './recovery';
import {ProcessJob,ProcessObservationTimeout} from './processes';
import {processCaseVerdict,type ProcessAttempt} from './process-verdict';
import type {Config} from './types';

/** Explicit opt-in only. The legacy full/visual verdict is intentionally independent. */
export async function runProcessCompatibility(config:Config,game:GameId,allowProcesses:boolean,signal:AbortSignal){
 if(!allowProcesses)throw new Error('进程测试会启动、终止并重启本轮游戏/XXMI；必须显式指定 --allow-processes');
 if(process.platform!=='win32')throw new Error('进程测试目前仅支持 Windows');
 const runner=createRunner();registerLocalSuites(runner);
 const local=await runner.run(config,game,'local',{signal});
 return withLock('execution',async()=>{
  const context=await stableContext(config,game,signal),id='process-'+randomUUID(),directory=outputPath(game,id);
  const notes:{step:string;status:ProcessCheckStatus;message:string;at?:string;pid?:number}[]=[];
  const checks:ProcessCompatibilityEvidence['checks']={local:local.report.selectedVerdict==='compatible'?'passed':'inconclusive',restart:'inconclusive',recovery:'inconclusive'};
  const attempts:{restart:ProcessAttempt[];recovery:ProcessAttempt[]}={restart:[],recovery:[]};
  let recoveryComplete=true,job:ProcessJob|undefined,target:Awaited<ReturnType<typeof probeCompatibilityTarget>>|undefined;
  const gameConfig=config.games[game]!;
  const xxmiRoot=context.xxmi.root||gameConfig.xxmiRoot||'';
  const fields:GamePaths={gameDirectory:gameConfig.gameRoot,xxmiRoot,modsDirectory:context.xxmi.modsDirectories[0]||''};
  const cleanup=async()=>{if(!job)return;try{const r=await job.close();if(!r.complete)throw new Error('专属进程恢复未完成');job=undefined;}catch(error){recoveryComplete=false;throw error;}};
  try{
   if(checks.local!=='passed'||local.report.context.observationKey!==context.observationKey||!context.game.executable||!context.xxmi.launchPlan||context.stability!=='stable')throw new Error('精确源码门禁、稳定上下文或标准启动计划未通过；未启动进程');
   const pending=await pendingRecovery();if(pending.length)throw new Error('存在未恢复记录，须先 recover：'+pending.join(', '));
   target=await probeCompatibilityTarget(game,fields,REPO);
   await saveJson(path.join(directory,'started-process.json'),{context,target,localReport:path.relative(OUTPUT,local.directory),scope:'restart-recovery'});
   const boot=async(step:string)=>{
    signal.throwIfAborted();job=await ProcessJob.create(directory);
    await job.assertAbsent([context.game.executable!,context.xxmi.launchPlan!.executable]);
    await job.start(context.xxmi.launchPlan!);
    const process=await job.waitForGame(context.game.executable!,signal);
    notes.push({step,status:'passed',message:'已观察到本轮专属进程组中的游戏进程（仅进程层）',pid:process.pid,at:new Date().toISOString()});return process;
   };
   for(const kind of ['restart','recovery'] as const){
    for(let attempt=0;attempt<2;attempt++){
     let controlPassed=false;
     try{
      const control=await boot(kind+'-control');controlPassed=true;
      if(kind==='recovery'){
       await job!.request({action:'crash',pid:control.pid});
       for(let i=0;i<100;i++){if(!(await job!.status()).some(p=>p.pid===control.pid))break;if(i===99)throw new Error('故障进程仍未退出');await delay(50,undefined,{signal});}
      }
      await cleanup();await boot(kind+'-target');
      attempts[kind].push({status:'passed',controlPassed,message:'本轮对照与目标进程启动均通过'});
     }catch(error){attempts[kind].push({status:controlPassed&&error instanceof ProcessObservationTimeout?'failed':'inconclusive',controlPassed,message:(error as Error).message});}
     finally{await cleanup();}
     if(attempts[kind].at(-1)!.status!=='failed'||signal.aborted)break;
     const current=await stableContext(config,game,signal);if(current.observationKey!==context.observationKey)break;
    }
    checks[kind]=processCaseVerdict(attempts[kind]);
   }
  }catch(error){notes.push({step:'interruption',status:'inconclusive',message:(error as Error).message});}
  finally{try{await cleanup();}catch(error){recoveryComplete=false;notes.push({step:'cleanup',status:'inconclusive',message:(error as Error).message});}}
  try{signal.throwIfAborted();const end=await stableContext(config,game,signal);const endTarget=await probeCompatibilityTarget(game,fields,REPO);if(end.observationKey!==context.observationKey||endTarget.fingerprint!==target?.fingerprint)throw new Error('运行期间上下文变化');}catch(error){checks.local='inconclusive';notes.push({step:'end-context',status:'inconclusive',message:(error as Error).message});}
  await saveJson(path.join(directory,'process-report.json'),{schemaVersion:1,id,context,target,checks,attempts,recoveryComplete,notes,scope:'restart-recovery'});
  let evidence:ProcessCompatibilityEvidence|undefined;
  if(target){const version=JSON.parse(await fs.readFile(path.join(REPO,'package.json'),'utf8')).version as string;const verdict=!recoveryComplete||Object.values(checks).includes('inconclusive')?'inconclusive':Object.values(checks).includes('failed')?'failed':'passed';evidence=sealCompatibilityEvidence({schemaVersion:1,kind:'kmm-process-compatibility',scope:'restart-recovery',gameId:game,managerVersion:version,sourceDigest:context.source.digest,runId:id,testedAt:new Date().toISOString(),target,checks,recoveryComplete,verdict});await saveJson(path.join(directory,'compatibility.json'),evidence);}
  if(evidence?.verdict==='failed'){
   const incident=sha(JSON.stringify([context.runKey,checks]));
   try{await saveJson(outputPath('incidents','process-'+incident,'task.json'),{schemaVersion:1,scope:'restart-recovery',status:'awaiting-development',publish:false,report:path.join(directory,'process-report.json'),evidence,attempts,command:'npm.cmd run compat -- run --config <配置绝对路径> --game '+game+' --suite process --allow-processes'},true);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  }
  return {directory,evidence,checks,recoveryComplete,notes,runKey:context.runKey,observationKey:context.observationKey,exitCode:evidence?.verdict==='passed'?0:evidence?.verdict==='failed'?1:2,gameCompatibility:'inconclusive' as const};
 });
}
