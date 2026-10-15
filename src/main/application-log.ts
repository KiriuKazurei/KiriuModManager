import {promises as fs,constants,appendFileSync,writeFileSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {assertNoLinks} from './archive';
import {writeAtomicJson} from './atomic-json';
import type {GameId} from '../shared/contracts';
import type {LogEvidence,LogFinding,LogLevel,LogReport} from '../shared/logging';

interface Trace {operationId:string;parentOperationId?:string;action:string;gameId?:GameId;origin?:string}
export const logContext=new AsyncLocalStorage<Trace>();
let active:ApplicationLog|undefined;
export function useApplicationLog(logger:ApplicationLog|undefined){active=logger;}
export function currentApplicationLog(){return active;}
export function logEvent(component:string,event:string,details:Record<string,unknown>={},level:LogLevel='info',error?:unknown){return active?.record(component,event,details,level,error)??Promise.resolve();}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
const MAX_BYTES=4*1024**2,ARCHIVES=5,MAX_READ_BYTES=8*1024**2,MAX_ROWS=20000;
const levels=['debug','info','warning','error','fatal'];
interface Options {installDirectory:string;dataDirectory:string;version:string;runtime?:Record<string,string>}
interface Row extends LogEvidence {[key:string]:any;component:string;error?:{name:string;message:string;stack?:string;code?:string};phase?:string;id?:string;result?:Record<string,any>}

export class ApplicationLog {
 readonly sessionId=randomUUID();readonly defaultDirectory:string;readonly profileId:string;directory:string;writable=true;writeFailures=0;
 private pending:Promise<void>=Promise.resolve();private memory:Row[]=[];private ended=false;private fatal=false;private startedAt=new Date().toISOString();private marker:string;
 private constructor(private options:Options){this.defaultDirectory=path.join(path.resolve(options.installDirectory),'log');this.directory=this.defaultDirectory;this.profileId=createHash('sha256').update(path.resolve(options.dataDirectory).toLowerCase()).digest('hex').slice(0,16);this.marker='session-'+this.profileId+'.json';}
 static async open(options:Options){
  const logger=new ApplicationLog(options);let opened=false;
  for(const directory of [...new Set([logger.defaultDirectory,path.join(path.resolve(options.dataDirectory),'log')])]){
   try{await assertNoLinks(directory);await fs.mkdir(directory,{recursive:true});await fs.access(directory,constants.W_OK);const probe=path.join(directory,'.probe-'+randomUUID());await fs.writeFile(probe,'',{flag:'wx'});await fs.unlink(probe);logger.directory=directory;opened=true;break;}catch{/* The fallback and its actual location are exposed in diagnostics. */}
  }
  logger.writable=opened;
  if(opened){
   try{const file=path.join(logger.directory,logger.marker);await assertNoLinks(file);const stat=await fs.stat(file);if(stat.size>16384)throw new Error('Session marker exceeds limit');const previous=JSON.parse(await fs.readFile(file,'utf8'));if(uuid(previous.sessionId)&&['running','fatal'].includes(previous.status))await logger.record('lifecycle',previous.status==='fatal'?'session.previous-fatal':'session.unexpected-exit',{previousSessionId:previous.sessionId,previousPid:previous.pid,previousStartedAt:previous.startedAt,reason:previous.status==='fatal'?'recorded-fatal':'no-clean-exit-marker'},'warning');}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')await logger.record('logging','session.marker-unreadable',{},'warning',error);}
   await logger.saveMarker('running');
   try{const files=[];for(const name of await fs.readdir(logger.directory))if(new RegExp('^fatal-'+logger.profileId+'-[a-f0-9-]{36}\\.jsonl$').test(name)){const file=path.join(logger.directory,name);await assertNoLinks(file);files.push({file,mtime:(await fs.stat(file)).mtimeMs});}for(const old of files.sort((a,b)=>b.mtime-a.mtime).slice(10))await fs.unlink(old.file);}catch{/* Retention failure must never block startup. */}
  }
  await logger.record('lifecycle','session.started',{appVersion:options.version,platform:process.platform,arch:process.arch,runtime:options.runtime,fallback:logger.directory!==logger.defaultDirectory,writable:logger.writable});return logger;
 }
 private cleanText(value:string){
  let text=value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'').slice(0,6000);
  for(const [root,label]of [[this.options.installDirectory,'[install]'],[this.options.dataDirectory,'[data]']]as const)if(root)for(const variant of new Set([path.resolve(root),path.resolve(root).replace(/\\/g,'/'),encodeURI(path.resolve(root).replace(/\\/g,'/'))])){const escaped=variant.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');text=text.replace(new RegExp(escaped,'gi'),label);}
  return text.replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi,'[url]').replace(/\bBearer\s+[^\s"']+/gi,'Bearer [redacted]').replace(/\b(password|passwd|token|cookie|authorization|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,'$1=[redacted]').replace(/(?:\b[a-z]:[\\/]|\\\\)[^\r\n<>"')]+/gi,'[path]');
 }
 private clean(value:unknown,depth=0,seen=new WeakSet<object>()):unknown{
  if(depth>5)return '[bounded]';if(typeof value==='string')return this.cleanText(value);if(typeof value==='number')return Number.isFinite(value)?value:null;if(typeof value==='boolean'||value===null)return value;if(value===undefined)return undefined;
  if(typeof value!=='object')return String(value);if(seen.has(value))return '[circular]';seen.add(value);
  if(Array.isArray(value))return value.slice(0,40).map(item=>this.clean(item,depth+1,seen));
  const result:Record<string,unknown>=Object.create(null);for(const [key,item]of Object.entries(value).slice(0,60)){if(/password|passwd|cookie|token|secret|authorization|credential|headers|body|settings|configuration|(?:^|_)url$/i.test(key))result[key]='[redacted]';else result[key]=this.clean(item,depth+1,seen);}return result;
 }
 error(error:unknown){const item=object(error);return {name:this.cleanText(error instanceof Error?error.name:'Error'),message:this.cleanText(error instanceof Error?error.message:typeof error==='string'?error:'Unknown error'),...(typeof item.code==='string'?{code:item.code.slice(0,80)}:{}),...(error instanceof Error&&error.stack?{stack:this.cleanText(error.stack.split('\n').slice(0,18).join('\n'))}:{})};}
 private row(component:string,event:string,details:Record<string,unknown>,level:LogLevel,error?:unknown):Row{
  const trace=logContext.getStore();return {...trace,...object(this.clean(details)),schemaVersion:2,version:1,time:new Date().toISOString(),level,sessionId:this.sessionId,pid:process.pid,component,event,...(error===undefined?{}:{error:this.error(error)})} as Row;
 }
 private file(index=0){return path.join(this.directory,'application-'+this.profileId+'.jsonl'+(index?'.'+index:''));}
 private async append(row:Row){
  let text=JSON.stringify(row)+'\n';if(Buffer.byteLength(text)>32*1024)text=JSON.stringify({schemaVersion:2,version:1,time:row.time,level:row.level,sessionId:row.sessionId,component:row.component,event:row.event,operationId:row.operationId,parentOperationId:row.parentOperationId,action:row.action,id:row.id,phase:row.phase,gameId:row.gameId,truncated:true,result:row.result?{status:row.result.status}:undefined,error:row.error?{name:row.error.name,code:row.error.code,message:row.error.message?.slice(0,1000)}:undefined})+'\n';
  await assertNoLinks(this.file());let size=0;try{size=(await fs.stat(this.file())).size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(size+Buffer.byteLength(text)+1>MAX_BYTES){for(let i=0;i<=ARCHIVES;i++)await assertNoLinks(this.file(i));await fs.rm(this.file(ARCHIVES),{force:true});for(let i=ARCHIVES-1;i>=0;i--)try{await fs.rename(this.file(i),this.file(i+1));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}size=0;}
  let prefix='';if(size){const file=await fs.open(this.file(),'r');try{const tail=Buffer.alloc(1);await file.read(tail,0,1,size-1);if(tail[0]!==10)prefix='\n';}finally{await file.close();}}
  await fs.appendFile(this.file(),prefix+text,'utf8');this.writable=true;
 }
 record(component:string,event:string,details:Record<string,unknown>={},level:LogLevel='info',error?:unknown){
  const row=this.row(component,event,details,level,error);this.memory.push(row);if(this.memory.length>200)this.memory.shift();
  const task=this.pending.then(()=>this.append(row));this.pending=task.catch(()=>{this.writable=false;this.writeFailures++;});return this.pending;
 }
 async flush(){await this.pending;}
 private async saveMarker(status:'running'|'clean'|'fatal',exitCode?:number){try{await writeAtomicJson(path.join(this.directory,this.marker),JSON.stringify({schemaVersion:1,sessionId:this.sessionId,pid:process.pid,startedAt:this.startedAt,status,exitCode,updatedAt:new Date().toISOString()}));}catch{this.writable=false;this.writeFailures++;}}
 fatalSync(event:string,error:unknown){
  if(this.fatal)return;
  this.fatal=true;const row=this.row('runtime',event,{},'fatal',error);this.memory.push(row);
  try{for(const target of [path.join(this.directory,'fatal-'+this.profileId+'-'+this.sessionId+'.jsonl'),path.join(this.directory,this.marker)]){for(let cursor=target;;cursor=path.dirname(cursor)){try{if(lstatSync(cursor).isSymbolicLink())throw new Error('Linked log target');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(path.dirname(cursor)===cursor)break;}}
   appendFileSync(path.join(this.directory,'fatal-'+this.profileId+'-'+this.sessionId+'.jsonl'),JSON.stringify(row)+'\n','utf8');const marker=path.join(this.directory,this.marker);writeFileSync(marker,JSON.stringify({schemaVersion:1,sessionId:this.sessionId,pid:process.pid,startedAt:this.startedAt,status:'fatal',updatedAt:new Date().toISOString()}));
  }catch{this.writable=false;this.writeFailures++;}
 }
 async close(exitCode=0){if(this.ended)return;this.ended=true;await this.record('lifecycle',this.fatal?'session.fatal-exit':'session.clean-exit',{exitCode},this.fatal?'fatal':'info');await this.saveMarker(this.fatal?'fatal':'clean',exitCode);await this.flush();}
 async recentRows(){
  await this.flush();const rows:Row[]=[];let remaining=MAX_READ_BYTES,files=0,malformedLines=0,truncated=false;
  const candidates=Array.from({length:ARCHIVES+1},(_,i)=>this.file(i));
  try{const extra=[];for(const name of await fs.readdir(this.directory))if(new RegExp('^fatal-'+this.profileId+'-[a-f0-9-]{36}\\.jsonl$').test(name)){const file=path.join(this.directory,name);await assertNoLinks(file);extra.push({file,mtime:(await fs.stat(file)).mtimeMs});}candidates.unshift(...extra.sort((a,b)=>b.mtime-a.mtime).slice(0,10).map(item=>item.file));}catch{/* Storage state is reported below. */}
  for(const file of candidates){if(remaining<=0||rows.length>=MAX_ROWS){truncated=true;break;}try{
   await assertNoLinks(file);const stat=await fs.stat(file);if(!stat.isFile())continue;const length=Math.min(stat.size,remaining),offset=stat.size-length;remaining-=length;files++;truncated||=offset>0;const input=await fs.open(file,'r'),bytes=Buffer.alloc(length);try{await input.read(bytes,0,length,offset);}finally{await input.close();}
   const text=bytes.toString('utf8'),lines=(offset?text.slice(text.indexOf('\n')+1):text).split('\n');
   for(const line of lines.reverse()){if(!line.trim())continue;if(rows.length>=MAX_ROWS){truncated=true;break;}try{const row=JSON.parse(line);if(row.schemaVersion!==2||!uuid(row.sessionId)||!levels.includes(row.level)||typeof row.event!=='string'||!/^[\w.-]{1,100}$/.test(row.event)||typeof row.time!=='string'||!Number.isFinite(Date.parse(row.time)))throw new Error('Invalid log row');rows.push(row);}catch{malformedLines++;}}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){malformedLines++;truncated=true;}}}
  if(!this.writable)for(const row of this.memory)if(!rows.some(item=>item.sessionId===row.sessionId&&item.time===row.time&&item.event===row.event&&item.operationId===row.operationId))rows.push(row);
  rows.sort((a,b)=>a.time.localeCompare(b.time));return {rows,files,malformedLines,truncated};
 }
 async report(game:GameId):Promise<LogReport>{
  const sample=await this.recentRows();const rows=sample.rows.filter(row=>!row.gameId||row.gameId===game);const findings=new Map<string,LogFinding>();
  const evidence=(row:Row):LogEvidence=>({time:row.time,level:row.level,event:row.event,sessionId:row.sessionId,...(uuid(row.operationId)?{operationId:row.operationId}:{}),...(uuid(row.parentOperationId)?{parentOperationId:row.parentOperationId}:{}),referenceIds:[...new Set([row.jobId,row.taskId,row.transactionId,...(Array.isArray(row.referenceIds)?row.referenceIds:[])].filter(uuid))].slice(0,40),...(typeof row.action==='string'?{action:this.cleanText(row.action)}:{}),...(row.gameId==='zzz'||row.gameId==='endfield'?{gameId:row.gameId}:{}),...(typeof row.error?.message==='string'?{message:this.cleanText(row.error.message)}:{}),...(typeof row.error?.code==='string'?{code:this.cleanText(row.error.code).slice(0,80)}:{})});
  const add=(kind:string,title:string,explanation:string,row:Row,level:'warning'|'error'='error')=>{let finding=findings.get(kind);if(!finding){finding={kind,title,explanation,level,count:0,evidence:[]};findings.set(kind,finding);}finding.count++;if(finding.evidence.length<8)finding.evidence.push(evidence(row));};
  const abnormal=new Set(rows.filter(r=>['session.unexpected-exit','session.previous-fatal'].includes(r.event)).map(r=>r.previousSessionId));
  const finished=new Set(rows.filter(row=>row.phase==='finish').map(row=>row.sessionId+':'+row.id));
  for(const row of rows){
   if(row.event==='session.unexpected-exit')add('abnormal-exit','上次会话未正常退出','缺少正常退出标记；可能为强制结束、断电或进程故障，日志不能单独确定原因。',row,'warning');
   else if(row.level==='fatal'||row.event==='session.previous-fatal')add('fatal','致命异常／崩溃记录','查看同一会话和操作 ID 的错误堆栈及前序事件；不据此推断游戏加载结果。',row);
   else if(row.event==='process.renderer-gone'&&row.reason!=='clean-exit')add('renderer-exit','界面或网页进程异常结束','Electron 报告了进程退出原因与退出码；可能是崩溃、内存不足或被终止。',row);
   else if(row.event==='process.child-gone'&&row.reason!=='clean-exit')add('child-exit','后台子进程异常结束','核对进程类型、退出码与同一时刻的其它异常。',row);
   if(row.event==='conflicts.observed'&&typeof row.groups==='number'&&row.groups>0)add('mod-conflict-candidates','Mod 静态冲突候选','日志中的检查发现有效启用 Mod 的 hash 重叠；记录可能已过期，请重新检查候选冲突，不能直接认定渲染错误。',row,'warning');
   const categories=Array.isArray(row.result?.failureCategories)?row.result!.failureCategories:[];const code=row.error?.code;
   if(code==='ENOSPC'||categories.includes('disk-full'))add('disk-full','磁盘空间不足','检查日志、缓存、Mod 库和恢复区所在卷的可用空间。',row);
   else if(['EACCES','EPERM'].includes(code||'')||categories.includes('access-denied'))add('access-denied','权限或文件访问失败','核对目标目录权限及安全软件拦截记录。',row);
   else if(code==='EBUSY'||categories.includes('busy'))add('busy','文件或目录被占用','核对占用进程；结合文件操作记录检查是否需要恢复。',row);
   else if(row.level==='error')add(row.component==='downloads'?'download-failure':'operation-error',row.component==='downloads'?'下载、绑定或校验失败':'操作或后台任务错误','按操作 ID／任务 ID 定位前序记录；先核对具体错误，再处理恢复记录。',row);
   if(row.phase==='start'&&abnormal.has(row.sessionId)&&!finished.has(row.sessionId+':'+row.id))add('unfinished-operation','异常退出前存在未观察到结束的操作','可能已经部分提交；以备份与恢复中的持久事务记录为准，日志不代替恢复协议。',row,'warning');
  }
  return {directory:this.directory,defaultDirectory:this.defaultDirectory,fallback:this.directory!==this.defaultDirectory,writable:this.writable,writeFailures:this.writeFailures,sessionId:this.sessionId,analyzedAt:new Date().toISOString(),files:sample.files,records:rows.length,malformedLines:sample.malformedLines,truncated:sample.truncated,findings:[...findings.values()],recent:rows.filter(row=>['warning','error','fatal'].includes(row.level)).slice(-60).reverse().map(evidence)};
 }
}
