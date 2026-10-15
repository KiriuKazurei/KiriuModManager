import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import type {GameId} from '../shared/contracts';
import {assertNoLinks} from './archive';

const actions=new Set(['environment:apply','mod-import:commit','mods:operate','mods:batch','mods:exclusive-save','mods:exclusive-delete','mods:import','mods:replace','mods:delete','mods:choose-cover','mods:group','characters:choose-cover','presets:save','presets:add-members','presets:delete','presets:apply','ini:save','recovery:create','recovery:restore','mods:install-download','profiles:capture','profiles:duplicate','profiles:apply','recovery:protect','recovery:apply-restore','recovery:apply-cleanup','recovery:cleanup-job','recovery:cleanup-run','diagnostics:export','presets:commit','preset-manifest:commit','preset-manifest:replacement','preset-manifest:export']);
const MAX_FILE_BYTES=2*1024**2,ARCHIVES=3,MAX_TARGETS=40;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const list=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
export function diagnosticLogRows(contents:string,game:GameId){
 const output:{time:string;id:string;action:string;status:string;referenceIds:string[];failureCategories:string[]}[]=[];let bytes=0;
 for(const line of contents.split('\n').filter(Boolean).slice(-100)){try{const row=object(JSON.parse(line)),result=object(row.result);if(row.gameId!==game||row.phase!=='finish'||!actions.has(String(row.action))||!uuid(row.id)||typeof row.time!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(row.time)||!['succeeded','partial','failed','canceled','awaiting-choice'].includes(String(result.status)))continue;
  const safe={time:row.time,id:row.id,action:String(row.action),status:String(result.status),referenceIds:list(row.referenceIds).filter(uuid).slice(0,40),failureCategories:list(result.failureCategories).filter((x):x is string=>typeof x==='string'&&['disk-full','busy','access-denied','interrupted','conflict','missing','operation-failed'].includes(x))};bytes+=Buffer.byteLength(JSON.stringify(safe));if(bytes>256*1024)break;output.push(safe);
 }catch{/* Partial or unrecognized log rows are not exported. */}}return output;
}
type Origin='main'|'floating'|'browser';
type ResultStatus='succeeded'|'partial'|'failed'|'canceled'|'awaiting-choice';
interface Context {directory:string;id:string;action:string;gameId?:GameId;origin:Origin;references:Set<string>;write:(entry:Record<string,unknown>)=>Promise<void>}
const context=new AsyncLocalStorage<Context>();
const category=(error:unknown)=>{const text=error instanceof Error?error.message:typeof error==='string'?error:'';const code=object(error).code;if(code==='ENOSPC'||/ENOSPC|磁盘.*不足|disk full/i.test(text))return 'disk-full';if(code==='EBUSY'||/EBUSY|占用/.test(text))return 'busy';if(code==='EACCES'||code==='EPERM'||/EACCES|EPERM|权限/.test(text))return 'access-denied';if(/未完成文件操作|中断/.test(text))return 'interrupted';if(/同名|已存在|冲突/.test(text))return 'conflict';if(code==='ENOENT'||/缺失|不存在/.test(text))return 'missing';return 'operation-failed';};

// References are emitted only inside an authorized, logged operation. Keep raw
// backup paths, configuration, text edits, URLs and cookies out of the log.
export async function logOperationReference(directory:string,gameId:GameId,kind:'backup'|'file-operation'|'environment-repair',id:string){
 const current=context.getStore();if(!current||path.resolve(directory)!==current.directory||current.gameId!==gameId||!uuid(id))return;
 current.references.add(id);await current.write({phase:'reference',reference:{kind,id}});
}
function targets(action:string,args:unknown[]){
 let ids:unknown[]=['recovery:protect'].includes(action)&&Array.isArray(args[1])?args[1]:[];
 const index=action==='mods:batch'?1:action==='presets:add-members'?2:3;
 if(['mods:batch','mods:exclusive-save','presets:add-members'].includes(action))ids=Array.isArray(args[index])?args[index] as unknown[]:[];
 if(['mods:operate','mods:replace','mods:delete','mods:choose-cover','mods:exclusive-delete','mods:exclusive-save','presets:save','presets:add-members','presets:delete','presets:apply','ini:save','recovery:restore','recovery:cleanup-run','recovery:cleanup-job'].includes(action))ids=[args[1],...ids];
 return [...new Set(ids.filter(uuid))];
}
function summary(action:string,args:unknown[],value:unknown){
 const result=object(value),items=list(result.items),errors=Array.isArray(result.errors)?list(result.errors):list(result.issues);
 const imported=list(result.importedIds).filter(uuid),failures=items.filter(item=>object(item).ok===false),successes=items.filter(item=>object(item).ok===true),applied=typeof result.applied==='number'&&Number.isSafeInteger(result.applied)?result.applied:undefined;
 const cleanup=typeof result.phase==='string'&&['prepared','working','pending','complete','undone'].includes(result.phase),deleted=cleanup?items.filter(i=>object(i).phase==='deleted').length:0;
 const status:ResultStatus=value===null||result.canceled===true?'canceled':cleanup&&result.phase==='pending'?(deleted?'partial':'awaiting-choice'):list(result.conflicts).length?'awaiting-choice':failures.length||errors.length?(successes.length||imported.length||(applied??0)>0?'partial':'failed'):'succeeded';
 const savedItems=action==='presets:save'?list(value):action==='mods:exclusive-save'?list(result.exclusiveGroups):[],saved=args[1]?savedItems.find(item=>object(item).id===args[1]):savedItems.at(-1);
 return {status,...(cleanup?{cleanupJobId:uuid(result.id)?result.id:undefined,deleted,retained:items.length-deleted,estimatedLogicalBytes:items.reduce<number>((sum,item)=>{const bytes=object(item).bytes;return sum+(typeof bytes==='number'&&Number.isSafeInteger(bytes)&&bytes>=0?bytes:0);},0)}:{}),...(uuid(object(saved).id)?{savedId:object(saved).id}:{}),...(items.length?{succeeded:successes.length,failed:failures.length}:{}),...(Array.isArray(result.importedIds)?{imported:imported.length}:{}),...(applied!==undefined?{applied}:{}),...(action==='preset-manifest:commit'?{savedId:uuid(result.presetId)?result.presetId:undefined,matched:typeof result.matched==='number'?result.matched:0,missing:list(result.missing).length,replacements:list(result.replacements).length}:{}),...(errors.length?{issues:errors.length}:{}),...(failures.length||errors.length?{failureCategories:[...new Set([...failures.map(item=>object(item).error),...errors].map(category))]}:{}),...(imported.length?{importedIds:imported.slice(0,MAX_TARGETS)}:{})};
}
export class OperationLog {
 private pending:Promise<void>=Promise.resolve();private warned=false;
 constructor(private directory:string){this.directory=path.resolve(directory);}
 private file(index=0){return path.join(this.directory,'logs','operations.jsonl'+(index?'.'+index:''));}
 private async append(entry:Record<string,unknown>){
  const line=JSON.stringify({version:1,time:new Date().toISOString(),...entry})+'\n',bytes=Buffer.byteLength(line);if(bytes>16*1024)throw new Error('操作日志记录过大。');
  await assertNoLinks(this.file());await fs.mkdir(path.dirname(this.file()),{recursive:true});let size=0,separator='';try{size=(await fs.stat(this.file())).size;if(size){const input=await fs.open(this.file(),'r');try{const tail=Buffer.alloc(1);await input.read(tail,0,1,size-1);if(tail[0]!==10)separator='\n';}finally{await input.close();}}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(size+bytes+separator.length>MAX_FILE_BYTES){
   for(let index=0;index<=ARCHIVES;index++)await assertNoLinks(this.file(index));
   await fs.rm(this.file(ARCHIVES),{force:true});for(let index=ARCHIVES-1;index>=0;index--){try{await fs.rename(this.file(index),this.file(index+1));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}separator='';
  }
  await fs.appendFile(this.file(),separator+line,'utf8');
 }
 private write(entry:Record<string,unknown>){this.pending=this.pending.then(()=>this.append(entry)).catch(()=>{if(!this.warned){this.warned=true;console.warn('本地操作日志写入失败，请检查数据目录空间与权限。');}});return this.pending;}
 async flush(){await this.pending;}
 async run<T>(action:string,args:unknown[],work:()=>Promise<T>,origin:Origin='main'):Promise<T>{
  if(!actions.has(action))return work();const gameId=args[0]==='zzz'||args[0]==='endfield'?args[0]:undefined,id=randomUUID(),ids=targets(action,args);
  const operation=object(args[2]),kind=typeof operation.kind==='string'&&['toggle','rename','metadata','provenance','classify','favorite','tags','requirements'].includes(operation.kind)?operation.kind:['folder','archive'].includes(args[action==='mods:import'?1:2] as string)?args[action==='mods:import'?1:2]:action==='mods:group'&&['category','character','appearance'].includes(args[1] as string)?args[1]:undefined;
  const common={id,action,origin,...(gameId?{gameId}:{}),...(kind?{kind}:{}),...(typeof operation.enabled==='boolean'?{enabled:operation.enabled}:{}),...(ids.length?{targetCount:ids.length,targetIds:ids.slice(0,MAX_TARGETS)}:{})};
  const current:Context={directory:this.directory,id,action,gameId,origin,references:new Set(),write:entry=>this.write({...common,...entry})};
  return context.run(current,async()=>{
   await current.write({phase:'start'});const started=Date.now();
   try{const value=await work();await current.write({phase:'finish',durationMs:Date.now()-started,result:summary(action,args,value),...(current.references.size?{referenceCount:current.references.size,referenceIds:[...current.references].slice(0,MAX_TARGETS)}:{})});return value;}
   catch(error){await current.write({phase:'finish',durationMs:Date.now()-started,result:{status:'failed',failureCategories:[category(error)]},...(current.references.size?{referenceCount:current.references.size,referenceIds:[...current.references].slice(0,MAX_TARGETS)}:{})});throw error;}
  });
 }
}
