import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {OUTPUT,readJson,saveJson} from './files';
import {isInside} from '../../../src/main/inspection-files';

export interface ProcessPlan {executable:string;args:string[];cwd:string}
export interface OwnedProcess {pid:number;executable:string}
export class ProcessObservationTimeout extends Error {}
interface Reply {ok:boolean;error?:string;ready?:boolean;complete?:boolean;processes?:OwnedProcess[];pid?:number}
const helper=path.resolve(__dirname,'../adapters/process-job.ps1');
function launch(mode:'serve'|'recover',jobName:string) {
 if(process.platform!=='win32')throw new Error('进程层目前仅支持 Windows');
 return spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Mode',mode,'-JobName',jobName],{windowsHide:true,stdio:'pipe'});
}
export class ProcessJob {
 private waiters:{resolve:(r:Reply)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}[]=[];
 private replies:Reply[]=[];private failure?:Error;private stderr='';
 private constructor(private child:ChildProcessWithoutNullStreams,readonly journal:string,readonly jobName:string) {
  const lines=createInterface({input:child.stdout});
  lines.on('line',line=>{try{const r=JSON.parse(line) as Reply;const w=this.waiters.shift();if(w){clearTimeout(w.timer);r.ok?w.resolve(r):w.reject(new Error(r.error||'进程操作失败'));}else this.replies.push(r);}catch{this.fail(new Error('进程助手输出无效'));}});
  child.stderr.on('data',data=>{this.stderr=(this.stderr+data).slice(-4000);});
  child.stdin.on('error',e=>this.fail(e));
  child.on('error',e=>this.fail(e));child.on('close',()=>this.fail(new Error('进程助手已结束 '+this.stderr)));
 }
 private fail(e:Error){this.failure=e;for(const w of this.waiters.splice(0)){clearTimeout(w.timer);w.reject(e);}}
 private next():Promise<Reply>{if(this.replies.length){const r=this.replies.shift()!;return r.ok?Promise.resolve(r):Promise.reject(new Error(r.error));}if(this.failure)return Promise.reject(this.failure);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.fail(new Error('进程助手响应超时'));this.child.kill();},15000);this.waiters.push({resolve,reject,timer});});}
 async request(request:Record<string,unknown>){if(this.failure)throw this.failure;this.child.stdin.write(JSON.stringify(request)+'\n');return this.next();}
 static async create(directory:string){
  const jobName='Local\\KMMCompat-'+randomUUID(),journal=path.join(directory,'process-'+randomUUID()+'.json');
  // Durable intent precedes the helper and any game process. No PID-based adoption.
  await saveJson(journal,{schemaVersion:1,kind:'kmm-process-job',jobName,phase:'pending'});
  const job=new ProcessJob(launch('serve',jobName),journal,jobName);
  try{await job.next();return job;}catch(error){job.child.stdin.end();await recoverProcessJournal(journal);throw error;}
 }
 async status(){return (await this.request({action:'status'})).processes!;}
 async assertAbsent(executables:string[]){for(const executable of executables){let existing:OwnedProcess[];try{existing=(await this.request({action:'existing',executable})).processes!;}catch{throw new Error('同名进程身份未确认，拒绝启动：'+path.basename(executable));}if(existing.some(p=>p.executable.toLowerCase()===executable.toLowerCase()))throw new Error('目标进程已在运行，未接管：'+path.basename(executable));}}
 async start(plan:ProcessPlan){await this.request({action:'start',...plan});}
 async waitForGame(executable:string,signal:AbortSignal,timeoutMs=120000,stableMs=2000){
  const until=Date.now()+timeoutMs;let first=0,pid=0;
  while(Date.now()<until){signal.throwIfAborted();const target=(await this.status()).find(p=>p.executable.toLowerCase()===executable.toLowerCase());if(target){if(pid!==target.pid){first=Date.now();pid=target.pid;}if(Date.now()-first>=stableMs)return target;}else{first=0;pid=0;}await delay(150,undefined,{signal});}
  throw new ProcessObservationTimeout('未观察到专属进程组内稳定运行的游戏；不表示 Mod 加载失败');
 }
 async stop(){await this.request({action:'stop'});for(let i=0;i<100;i++){if(!(await this.status()).length)return;await delay(50);}throw new Error('专属进程组尚未退出');}
 async close(){
  // Even if the protocol is broken, opening the durable named job can clean it.
  try{if(!this.failure)await this.stop();}catch{/* Recovery uses the kernel job, not the failed protocol. */}finally{this.child.stdin.end();}
  return recoverProcessJournal(this.journal);
 }
}
export async function recoverProcessJournal(file:string){
 const value=await readJson(file) as {schemaVersion:number;kind:string;jobName:string;phase:string};
 if(!/^process-[a-f0-9-]{36}\.json$/.test(path.basename(file))||!isInside(OUTPUT,file)||value.schemaVersion!==1||value.kind!=='kmm-process-job'||!/^Local\\KMMCompat-[a-f0-9-]{36}$/.test(value.jobName)||!['pending','complete'].includes(value.phase))throw new Error('进程恢复记录无效');
 if(value.phase==='complete')return {complete:true};
 const child=launch('recover',value.jobName);let out='',err='';
 const complete=await new Promise<boolean>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('恢复助手超时'));},20000);child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err=(err+d).slice(-4000));child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);try{if(code!==0)throw new Error(err);const r=JSON.parse(out);resolve(r.ok===true&&r.complete===true);}catch(e){reject(e);}});});
 if(complete)await saveJson(file,{...value,phase:'complete'});
 return {complete};
}
