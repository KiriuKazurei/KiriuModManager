import {promises as fs,constants} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {GameId,RecoveryItem} from '../shared/contracts';
import {GAMES} from '../shared/contracts';
import {assertNoLinks,containedPath} from './archive';
import {writeAtomicJson,writeAtomicFile} from './atomic-json';
import {logOperationReference} from './operation-log';

type Identity={dev:string;ino:string};
type Change={kind:'swap';target:string;source?:string;newOnly?:boolean}|{kind:'move';from:string;target:string};
export type MetadataChange={target:string;bytes:Buffer|string|null;gameSettings?:boolean;expected?:string};
type Step=Change&{work:string;old?:Identity;incoming?:Identity};
type Meta={target:string;before:boolean;after:boolean;gameSettings?:boolean};
export interface ProfileFileChange {target:string;bytes:Buffer;expected:string}
type ProfileFile={target:string;before:string;after:string};
interface Operation {version:1|2;purpose?:'profile-switch'|'preset-switch'|'preset-import'|'mod-tags';files?:ProfileFile[];id:string;gameId:GameId;root:string;name:string;createdAt:string;phase:'preparing'|'applying'|'committed'|'rolled-back';steps:Step[];metadata:Meta[]}
const same=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const inside=(root:string,file:string)=>{const relative=path.relative(path.resolve(root),path.resolve(file));return !relative||!relative.startsWith('..')&&!path.isAbsolute(relative);};
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function present(file:string){try{await fs.lstat(file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function identity(file:string):Promise<Identity|undefined>{try{const stat=await fs.lstat(file,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('操作目录不是普通目录。');return {dev:String(stat.dev),ino:String(stat.ino)};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}}
const matches=(a:Identity|undefined,b:Identity|undefined)=>!!a&&!!b&&a.dev===b.dev&&a.ino===b.ino;
export async function moveDirectory(from:string,to:string){const expected=await identity(from);if(!expected)throw new Error('移动来源目录缺失。');for(let attempt=0;;attempt++){try{await assertNoLinks(from);await assertNoLinks(to);if(!matches(await identity(from),expected)||!same(from,to)&&await present(to))throw new Error('移动来源或目标已改变，未覆盖。');await fs.rename(from,to);return;}catch(error){if(process.platform!=='win32'||attempt>=7||!['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code||''))throw error;await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));}}}
async function copy(source:string,target:string){await assertNoLinks(source);await assertNoLinks(target);if(await present(target))throw new Error('准备目录已存在。');await fs.mkdir(target);for(const item of await fs.readdir(source,{withFileTypes:true})){const from=path.join(source,item.name),to=containedPath(target,item.name);if(item.isSymbolicLink())throw new Error('来源包含链接，未提交。');if(item.isDirectory())await copy(from,to);else if(item.isFile())await fs.copyFile(from,to,constants.COPYFILE_EXCL);else throw new Error('来源包含特殊文件。');}}

// A narrowly scoped directory commit, not a global transaction. Complete staged
// content and original directory identities survive abrupt process termination.
import {logEvent} from './application-log';
export class FileOperations {
 constructor(private data:string){}
 private folder(){return path.join(this.data,'pending-operations');}
 private recordFile(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('中断操作身份无效。');return path.join(this.folder(),id+'.json');}
 private metaFolder(id:string){return path.join(this.folder(),id);}
 private async store(op:Operation){await writeAtomicJson(this.recordFile(op.id),JSON.stringify(op));await logEvent('files','file-operation.checkpoint',{transactionId:op.id,gameId:op.gameId,phase:op.phase,purpose:op.purpose,steps:op.steps.length,files:op.files?.length||0});}
 private validate(op:Operation){
  if(![1,2].includes(op.version)||!Object.hasOwn(GAMES,op.gameId)||typeof op.root!=='string'||!path.isAbsolute(op.root)||same(op.root,path.parse(op.root).root)||typeof op.name!=='string'||!['preparing','applying','committed','rolled-back'].includes(op.phase)||!Array.isArray(op.steps)||(op.version===1?(!op.steps.length||op.steps.length>8):op.steps.length>5000)||!Array.isArray(op.metadata)||op.metadata.length>4)throw new Error('中断操作记录无效，原文件保留。');
  if(op.version===2&&(!['profile-switch','preset-switch','preset-import','mod-tags'].includes(op.purpose||'')||!Array.isArray(op.files)||op.files.length>2048||op.files.some(file=>typeof file.target!=='string'||!path.isAbsolute(file.target)||!inside(op.root,file.target)||!/^.{1,}\.ini$/i.test(path.basename(file.target))||/^desktop\.ini$/i.test(path.basename(file.target))||!/^[a-f0-9]{64}$/.test(file.before)||!/^[a-f0-9]{64}$/.test(file.after))||new Set(op.files.map(file=>file.target.toLowerCase())).size!==op.files.length))throw new Error('配置档文件操作无效。');
  if(op.purpose==='preset-switch'&&(op.files?.length||op.steps.some(step=>step.kind!=='move'||!inside(op.root,step.target)||same(op.root,step.target))||op.metadata.some(meta=>!same(meta.target,path.join(this.data,'library-'+op.gameId+'.json')))))throw new Error('预设提交只允许当前 Mod 根内目录启停及库索引。');
  const importedProfile=(target:string)=>{if(typeof target!=='string'||!path.isAbsolute(target))return false;const relative=path.relative(path.join(this.data,'profiles',op.gameId),target).split(path.sep);return relative.length===2&&relative.every(part=>/^[a-f0-9-]{36}$/.test(part));};
  if(op.purpose==='preset-import'&&(op.files?.length||op.steps.length>1||op.steps.some(step=>step.kind!=='swap'||!step.newOnly||step.old||!importedProfile(step.target))||op.metadata.some(meta=>!same(meta.target,path.join(this.data,'presets-'+op.gameId+'.json')))))throw new Error('清单提交只允许新建非活动配置及预设索引。');
  this.recordFile(op.id);const covers=path.join(this.data,'character-covers',op.gameId);
  op.steps.forEach((step,index)=>{
   if(!step||typeof step.target!=='string'||!path.isAbsolute(step.target))throw new Error('中断操作路径无效，未处理。');
   const workNames=['DISABLED_.kmm-operation-','.kmm-operation-'].map(prefix=>path.join(path.dirname(step.target),prefix+op.id+'-'+index));
   if(!['swap','move'].includes(step.kind)||!(inside(op.root,step.target)||same(step.target,covers)||same(step.target,path.join(this.data,'profiles',op.gameId))||op.purpose==='preset-import'&&importedProfile(step.target))||!workNames.includes(step.work)||step.kind==='move'&&(typeof step.from!=='string'||!path.isAbsolute(step.from)||!inside(op.root,step.from)||same(step.from,op.root))||step.kind==='swap'&&step.source!==undefined&&(typeof step.source!=='string'||!path.isAbsolute(step.source)))throw new Error('中断操作路径无效，未处理。');
   for(const item of [step.old,step.incoming])if(item&&(!/^\d+$/.test(item.dev)||!/^\d+$/.test(item.ino)))throw new Error('中断操作目录身份无效。');
  });
  const tagsFile=(file:string)=>typeof file==='string'&&path.isAbsolute(file)&&inside(op.root,file)&&!same(path.dirname(file),op.root)&&path.basename(file)==='tags.json';
  if(op.purpose==='mod-tags'&&(op.steps.length||op.files?.length||op.metadata.length!==2||op.metadata.filter(meta=>tagsFile(meta.target)).length!==1||op.metadata.filter(meta=>same(meta.target,path.join(this.data,'library-'+op.gameId+'.json'))).length!==1))throw new Error('标签提交只允许当前 Mod 的 tags.json 与库索引。');
  const files=[path.join(this.data,'library-'+op.gameId+'.json'),path.join(this.data,'presets-'+op.gameId+'.json'),path.join(this.data,'settings.json')];
  if(op.metadata.some(meta=>typeof meta?.target!=='string'||!files.some(file=>same(file,meta.target))&&!(op.purpose==='mod-tags'&&tagsFile(meta.target))||typeof meta.before!=='boolean'||typeof meta.after!=='boolean'||meta.gameSettings&& !same(meta.target,files[2]))||new Set(op.metadata.map(meta=>meta.target.toLowerCase())).size!==op.metadata.length)throw new Error('中断操作元数据路径无效。');
 }
 private async read(id:string):Promise<Operation>{const file=this.recordFile(id);await assertNoLinks(file);if((await fs.stat(file)).size>4*1024*1024)throw new Error('中断记录过大。');const op=JSON.parse(await fs.readFile(file,'utf8'));if(op.id!==id)throw new Error('中断记录身份不符。');this.validate(op);return op;}
 async list(game:GameId):Promise<RecoveryItem[]>{await assertNoLinks(this.folder());let files:string[];try{files=await fs.readdir(this.folder());}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}const rows:RecoveryItem[]=[];for(const file of files.filter(file=>/^[a-f0-9-]{36}\.json$/.test(file))){const op=await this.read(file.slice(0,-5));if(op.gameId===game)rows.push({id:op.id,gameId:game,root:op.root,kind:op.phase==='rolled-back'?'legacy':'interrupted',name:(op.phase==='rolled-back'?'已回退，新内容副本：':op.phase==='committed'?'已完成，待清理：':'中断操作：')+op.name,createdAt:op.createdAt,includesContent:true,...(op.phase==='rolled-back'?{manualLocation:op.steps.map(step=>path.join(step.work,'rolled-back')).join('\n')}:{})});}return rows;}
 async info(game:GameId,id:string){if(!await present(this.recordFile(id)))return null;const op=await this.read(id);if(op.gameId!==game)throw new Error('中断操作属于其它游戏。');return op;}
 async assertReady(game:GameId,root:string){for(const row of await this.list(game)){const op=await this.read(row.id);if(same(op.root,root)&&!['committed','rolled-back'].includes(op.phase))throw new Error('此目录有未完成文件操作，请到“备份与恢复”处理中断操作后继续。');}}
 private async removeOwned(folder:string,id:string){if(!await present(folder))return;await assertNoLinks(folder);const owner=path.join(folder,'owner');await assertNoLinks(owner);if(!await present(owner)){if((await fs.readdir(folder)).length)throw new Error('临时目录缺少归属信息，已保留。');await fs.rmdir(folder);return;}if(await fs.readFile(owner,'utf8')!==id)throw new Error('临时目录归属不符，已保留。');await fs.rm(folder,{recursive:true});}
 private async cleanup(op:Operation){for(const step of op.steps)await this.removeOwned(step.work,op.id);await this.removeOwned(this.metaFolder(op.id),op.id);await fs.unlink(this.recordFile(op.id));}
 private async metaBytes(op:Operation,index:number,side:'before'|'after'){const file=path.join(this.metaFolder(op.id),index+'-'+side);await assertNoLinks(file);return fs.readFile(file);}
 private equivalent(op:Operation,meta:Meta,a:Buffer|null,b:Buffer|null){if(a===null||b===null)return a===b;if(meta.gameSettings)return JSON.stringify(JSON.parse(a.toString()).games[op.gameId])===JSON.stringify(JSON.parse(b.toString()).games[op.gameId]);return digest(a)===digest(b);}
 private async writeMeta(op:Operation,meta:Meta,bytes:Buffer|null){
  if(bytes===null){await fs.rm(meta.target,{force:true});return;}
  if(meta.gameSettings){const current=JSON.parse(await fs.readFile(meta.target,'utf8'));const saved=JSON.parse(bytes.toString());bytes=Buffer.from(JSON.stringify({...current,games:{...current.games,[op.gameId]:saved.games[op.gameId]}},null,2));}
  await writeAtomicJson(meta.target,bytes.toString('utf8'));
 }
 async rollback(game:GameId,id:string,root:string){const op=await this.read(id);if(op.gameId!==game||!same(op.root,root))throw new Error('中断操作的游戏或根目录与当前设置不符。');
  if(op.phase==='committed'){await this.cleanup(op);return;}
  if(op.phase==='rolled-back')throw new Error('操作已回退，新内容副本仅供人工核对。');
  // Validate the whole rollback before touching any original. Never overwrite a
  // directory or metadata file changed by a user after the interrupted operation.
  for(const step of op.steps){await assertNoLinks(step.target);await assertNoLinks(step.work);if(step.kind==='move'){await assertNoLinks(step.from);const from=await identity(step.from),to=await identity(step.target);if(!matches(from,step.old)&&!matches(to,step.old)||to&&!matches(to,step.old)||from&&!matches(from,step.old))throw new Error('中断操作目录已被外部修改，请保留副本并人工核对。');}else{const current=await identity(step.target),old=await identity(path.join(step.work,'original'));if(old&&!matches(old,step.old)||current&&!matches(current,step.old)&&!matches(current,step.incoming)||step.old&&!matches(old,step.old)&&!matches(current,step.old))throw new Error('中断操作目录身份已变化，请保留副本并人工核对。');}}
  if(op.phase==='applying')for(let index=0;index<op.metadata.length;index++){const meta=op.metadata[index];await assertNoLinks(meta.target);const current=await present(meta.target)?await fs.readFile(meta.target):null,before=meta.before?await this.metaBytes(op,index,'before'):null,after=meta.after?await this.metaBytes(op,index,'after'):null;if(!this.equivalent(op,meta,current,before)&&!this.equivalent(op,meta,current,after))throw new Error('中断操作元数据已被外部修改，未覆盖。');}
  if(op.phase==='applying')for(const file of op.files||[]){let actual=file.target;for(const step of op.steps)if(step.kind==='move'&&inside(step.from,file.target)&&matches(await identity(step.target),step.old))actual=path.join(step.target,path.relative(step.from,file.target));await assertNoLinks(actual);const current=digest(await fs.readFile(actual));if(current!==file.before&&current!==file.after)throw new Error('配置档 INI 已被外部修改，保留副本并停止回退。');}
  for(const step of [...op.steps].reverse()){
   if(step.kind==='move'){if(matches(await identity(step.target),step.old))await moveDirectory(step.target,step.from);}
   else{if(matches(await identity(step.target),step.incoming))await moveDirectory(step.target,path.join(step.work,'rolled-back'));if(matches(await identity(path.join(step.work,'original')),step.old))await moveDirectory(path.join(step.work,'original'),step.target);}
  }
  if(op.phase==='applying')for(let index=0;index<(op.files||[]).length;index++){const file=op.files![index];await assertNoLinks(file.target);const current=digest(await fs.readFile(file.target));if(current!==file.before)await writeAtomicFile(file.target,await fs.readFile(path.join(this.metaFolder(op.id),'ini-'+index+'-before')),current);}
  if(op.phase==='applying')for(let index=0;index<op.metadata.length;index++){const meta=op.metadata[index],before=meta.before?await this.metaBytes(op,index,'before'):null,current=await present(meta.target)?await fs.readFile(meta.target):null;if(!this.equivalent(op,meta,current,before))await this.writeMeta(op,meta,before);}
  if((await Promise.all(op.steps.map(step=>present(path.join(step.work,'rolled-back'))))).some(Boolean)){op.phase='rolled-back';await this.store(op);}else await this.cleanup(op);
 }
 async runProfile(game:GameId,root:string,name:string,files:ProfileFileChange[],changes:Change[],metadata:MetadataChange[]){return this.run(game,root,name,changes,metadata,files);}
 async runPreset(game:GameId,root:string,name:string,changes:Change[],metadata:MetadataChange[]){return this.run(game,root,name,changes,metadata,[],'preset-switch');}
 async runPresetImport(game:GameId,root:string,name:string,changes:Change[],metadata:MetadataChange[]){return this.run(game,root,name,changes,metadata,[],'preset-import');}
 async run(game:GameId,root:string,name:string,changes:Change[],metadata:MetadataChange[],files?:ProfileFileChange[],purpose:'profile-switch'|'preset-switch'|'preset-import'|'mod-tags'='profile-switch',beforeCommit?:(incoming:string[])=>Promise<void>){
  await this.assertReady(game,root);const id=randomUUID();const op:Operation={version:files?2:1,...(files?{purpose,files:[]}:{}),id,gameId:game,root,name,createdAt:new Date().toISOString(),phase:'preparing',steps:[],metadata:[]};
  let budget=0;for(const file of files||[]){await assertNoLinks(file.target);const stat=await fs.stat(file.target);if(stat.size>4*1024*1024||file.bytes.length>4*1024*1024||(budget+=stat.size+file.bytes.length)>128*1024*1024)throw new Error('配置档文件超出大小预算。');if(digest(await fs.readFile(file.target))!==file.expected)throw new Error('INI 在预览后已改变，请重新读取。');op.files!.push({target:file.target,before:file.expected,after:digest(file.bytes)});}
  for(let index=0;index<changes.length;index++){const change=changes[index];await assertNoLinks(change.target);const old=await identity(change.kind==='move'?change.from:change.target);if(change.kind==='swap'&&change.newOnly&&old)throw new Error('目标已有同名 Mod，原内容保持。');if(change.kind==='move'&&(!old||!same(change.from,change.target)&&await present(change.target)))throw new Error('移动来源已缺失或目标已存在。');op.steps.push({...change,work:path.join(path.dirname(change.target),'DISABLED_.kmm-operation-'+id+'-'+index),old});}
  for(const change of metadata){await assertNoLinks(change.target);op.metadata.push({target:change.target,before:await present(change.target),after:change.bytes!==null,gameSettings:change.gameSettings});}
  this.validate(op);await this.store(op);await logOperationReference(this.data,game,'file-operation',id);
  try{
   await fs.mkdir(this.metaFolder(id));await fs.writeFile(path.join(this.metaFolder(id),'owner'),id,{flag:'wx'});
   for(let index=0;index<metadata.length;index++){if(op.metadata[index].before)await fs.copyFile(metadata[index].target,path.join(this.metaFolder(id),index+'-before'));if(metadata[index].expected!==undefined&&(op.metadata[index].before?digest(await fs.readFile(path.join(this.metaFolder(id),index+'-before'))):'missing')!==metadata[index].expected)throw new Error('元数据在计划确认后已改变，未提交。');if(metadata[index].bytes!==null)await fs.writeFile(path.join(this.metaFolder(id),index+'-after'),metadata[index].bytes!);}
   for(let index=0;index<(files||[]).length;index++){const file=files![index];await fs.copyFile(file.target,path.join(this.metaFolder(id),'ini-'+index+'-before'));if(digest(await fs.readFile(path.join(this.metaFolder(id),'ini-'+index+'-before')))!==file.expected)throw new Error('INI 在准备期间发生变化。');await fs.writeFile(path.join(this.metaFolder(id),'ini-'+index+'-after'),file.bytes);}
   for(const step of op.steps){await fs.mkdir(path.dirname(step.work),{recursive:true});await fs.mkdir(step.work);await fs.writeFile(path.join(step.work,'owner'),id,{flag:'wx'});if(step.kind==='swap'&&step.source){await copy(step.source,path.join(step.work,'incoming'));step.incoming=await identity(path.join(step.work,'incoming'));}}
   if(beforeCommit)await beforeCommit(op.steps.filter(step=>step.kind==='swap'&&step.source).map(step=>path.join(step.work,'incoming')));
   op.phase='applying';await this.store(op);
   for(let index=0;index<(files||[]).length;index++)await writeAtomicFile(files![index].target,files![index].bytes,files![index].expected);
   for(const step of op.steps){await fs.mkdir(path.dirname(step.target),{recursive:true});await assertNoLinks(step.target);if(step.kind==='move'){if(!matches(await identity(step.from),step.old)||!same(step.from,step.target)&&await present(step.target))throw new Error('移动目录在准备期间改变，未覆盖。');await moveDirectory(step.from,step.target);}else{if(step.old){if(!matches(await identity(step.target),step.old))throw new Error('目标目录在准备期间改变，未覆盖。');await moveDirectory(step.target,path.join(step.work,'original'));}else if(await present(step.target))throw new Error('目标在准备期间出现同名目录，未覆盖。');if(step.incoming)await moveDirectory(path.join(step.work,'incoming'),step.target);}}
   for(let index=0;index<op.metadata.length;index++){const meta=op.metadata[index];const current=await present(meta.target)?await fs.readFile(meta.target):null,before=meta.before?await this.metaBytes(op,index,'before'):null;if(!this.equivalent(op,meta,current,before))throw new Error('元数据在准备期间被外部修改，未覆盖。');await this.writeMeta(op,meta,meta.after?await this.metaBytes(op,index,'after'):null);}
   op.phase='committed';await this.store(op);
  }catch(error){try{await this.rollback(game,id,root);}catch(rollback){throw new Error(`${(error as Error).message}；文件与副本已保留，请到“备份与恢复”处理：${(rollback as Error).message}`);}throw error;}
  // A lock while cleaning old staging does not turn a committed operation into
  // failure. Its committed record stays visible for later, safe cleanup.
  await this.cleanup(op).catch(()=>{});
 }
}
