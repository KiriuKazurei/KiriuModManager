import {randomUUID} from 'node:crypto';
import type {GameId,GamePaths} from '../shared/contracts';
import type {InspectionJob,InspectionKind} from '../shared/inspections';
export class ReadJobs {
 private jobs=new Map<string,{job:InspectionJob;controller:AbortController;evidence:string;expires:number;validate?:()=>Promise<boolean>;checked:number;requestKey:string}>();
 constructor(private fingerprint:(game:GameId)=>Promise<string>){}
 async start(kind:InspectionKind,gameId:GameId,paths:GamePaths,work:(signal:AbortSignal,progress:(message:string)=>void)=>Promise<InspectionJob['result']>,validate?:()=>Promise<boolean>,requestKey=''){
  this.prune(true);const running=[...this.jobs.values()].filter(item=>item.job.stage==='running');const existing=running.find(item=>item.job.kind===kind&&item.job.gameId===gameId);if(existing){if(existing.controller.signal.aborted||existing.requestKey!==requestKey)throw new Error('上一项同类读取正在运行或取消，请等待完成后重试。');return structuredClone(existing.job);}if(running.length>=2)throw new Error('已有两个只读任务，请等待或取消一个。');
  const job:InspectionJob={id:randomUUID(),kind,gameId,paths:{...paths},stage:'running',progress:'准备读取',observedAt:new Date().toISOString(),stale:false,warnings:[]};const item={job,controller:new AbortController(),evidence:await this.fingerprint(gameId),expires:Date.now()+600000,validate,checked:0,requestKey};this.jobs.set(job.id,item);
  void (async()=>{try{const result=await work(item.controller.signal,message=>{job.progress=message;});item.controller.signal.throwIfAborted();job.result=result;job.stale=item.evidence!==await this.fingerprint(gameId);job.stage='complete';job.progress='读取完成';}catch(error){job.stage=item.controller.signal.aborted?'canceled':'error';job.progress=item.controller.signal.aborted?'已取消':(error as Error).message;}finally{item.expires=Date.now()+600000;}})();return structuredClone(job);
 }
 async read(id:string,force=false){this.prune();const item=this.jobs.get(id);if(!item)throw new Error('读取结果已过期，请重新检查。');if(item.job.stage!=='running'){item.job.stale||=item.evidence!==await this.fingerprint(item.job.gameId);if(!item.job.stale&&item.validate&&(force||Date.now()-item.checked>1000)){item.job.stale||=!await item.validate();item.checked=Date.now();}}return structuredClone(item.job);}
 cancel(id:string){const item=this.jobs.get(id);if(!item)throw new Error('读取任务不存在。');item.controller.abort();item.job.stale=true;return structuredClone(item.job);}
 invalidate(game:GameId){for(const item of this.jobs.values())if(item.job.gameId===game)item.job.stale=true;}
 private prune(reserve=false){for(const [id,item]of this.jobs)if(item.job.stage!=='running'&&item.expires<Date.now())this.jobs.delete(id);while(this.jobs.size>(reserve?19:20)){const entry=[...this.jobs].find(([,v])=>v.job.stage!=='running');if(!entry)break;this.jobs.delete(entry[0]);}}
}
