import type {DownloadItem} from 'electron';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {GameId,ImportResult,ModDownload,ModDownloadAction,ModDownloadInstallItem,ModDownloadInstallPlan,ModInstallDestination,ModUpdateTarget} from '../shared/contracts';
import {GAMES} from '../shared/contracts';
import {assertNoLinks,containedPath} from './archive';
import {downloadFileName,gameBananaUrl,MAX_MOD_DOWNLOAD,ModDirectoryChangedError,readDownloadBinding,resolveGameBananaFile,verifyModDownload} from './gamebanana';
import type {GameBananaDownload} from './gamebanana';
import {writeAtomicJson} from './atomic-json';
import {logEvent} from './application-log';

interface Task {status:ModDownload;modId:number;urls:string[];binding?:GameBananaDownload;item?:DownloadItem;controller?:AbortController;running?:Promise<void>;stopped:boolean;failure?:string}
const activeStages=['binding','downloading','verifying','installing'];
const stages=[...activeStages,'ready','waiting-directory','complete','partial','error','canceled','interrupted'];
export interface ModDownloadOptions {
 cache:string;fetch:typeof fetch;root:(game:GameId)=>Promise<string>;
 install:(file:string,root:string,binding:GameBananaDownload,destinations?:ModInstallDestination[],target?:ModUpdateTarget)=>Promise<ImportResult&{items:ModDownloadInstallItem[]}>;
 plan:(file:string,root:string,binding:GameBananaDownload,target?:ModUpdateTarget)=>Promise<ModDownloadInstallPlan>;
 canStart:()=>boolean;confirmRoot:(oldRoot:string,newRoot:string)=>Promise<boolean>;
 requestDownload:(modId:number,url:string,game:GameId,target?:ModUpdateTarget)=>void;showFile:(file:string)=>void;
}
export class ModDownloads {
 private tasks:Task[]=[];
 private pending:Promise<void>=Promise.resolve();
 private closed=false;
 private available=true;
 error='';
 constructor(private options:ModDownloadOptions){}
 async initialize(){
  try{
   await assertNoLinks(this.options.cache);
   const file=path.join(this.options.cache,'tasks.json');await assertNoLinks(file);
   let input:any;
   try{const stat=await fs.stat(file);if(stat.size>16*1024**2)throw new Error('下载任务记录过大。');input=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
   if(input?.version!==1||!Array.isArray(input.tasks)||input.tasks.length>5000)throw new Error('下载任务记录格式无效。');
   const ids=new Set<string>();const loaded:Task[]=[];let changed=false;
   for(const row of input.tasks){
    const s=row?.status as ModDownload;if(s?.updateTarget&&(!/^[a-f0-9-]{36}$/.test(s.updateTarget.modId)||!/^[a-f0-9-]{36}$/.test(s.updateTarget.contentRevision)||typeof s.updateTarget.candidateVersion!=='string'||s.updateTarget.candidateVersion.length>120)||s?.purpose==='update'&&!s.updateTarget)throw new Error('更新任务身份无效。');
    if(!s||typeof s.id!=='string'||!/^[a-f0-9-]{36}$/.test(s.id)||ids.has(s.id)||!Object.hasOwn(GAMES,s.gameId)||typeof s.targetRoot!=='string'||s.targetRoot&&!path.isAbsolute(s.targetRoot)||!stages.includes(s.stage)||!Number.isSafeInteger(row.modId)||row.modId<=0||!Array.isArray(row.urls)||!row.urls.length||!Array.isArray(s.importedIds)||s.importedIds.some(id=>typeof id!=='string')||!Array.isArray(s.items)||s.items.some(item=>!item||typeof item.name!=='string'||typeof item.ok!=='boolean')||typeof s.archiveReady!=='boolean'||typeof s.title!=='string'||typeof s.message!=='string'||![s.createdAt,s.updatedAt].every(time=>typeof time==='string'&&Number.isFinite(Date.parse(time)))||![s.receivedBytes,s.totalBytes].every(bytes=>Number.isSafeInteger(bytes)&&bytes>=0)||s.totalBytes>MAX_MOD_DOWNLOAD||row.urls.length>20)throw new Error('下载任务内容无效。');
    if(s.character!==undefined&&(typeof s.character!=='string'||s.character.length>120||/[\x00-\x1f]/.test(s.character)))throw new Error('下载任务角色信息无效。');
    if(s.updateTarget&&(s.updateTarget.root!==undefined&&(typeof s.updateTarget.root!=='string'||!path.isAbsolute(s.updateTarget.root))||s.updateTarget.candidateFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(s.updateTarget.candidateFingerprint)))throw new Error('更新任务目录或候选指纹无效。');ids.add(s.id);downloadFileName(s.fileName);row.urls.forEach((url:string)=>gameBananaUrl(url,true));
    const task:Task={status:{...s},modId:row.modId,urls:row.urls,binding:row.binding?readDownloadBinding(row.binding,s.gameId):undefined,stopped:false};
    if(task.status.archiveReady){try{await assertNoLinks(this.file(task));const stat=await fs.stat(this.file(task));if(!stat.isFile()||stat.size!==task.status.receivedBytes)throw new Error('missing');}catch{task.status.archiveReady=false;changed=true;}}
    if(activeStages.includes(task.status.stage)){task.status.stage='interrupted';task.status.message='上次任务已中断；完整包可重试安装，否则请重新下载。';task.status.updatedAt=new Date().toISOString();changed=true;}
    loaded.push(task);
   }
   this.tasks=loaded;if(changed)await this.persist();await logEvent('downloads','download.records-restored',{tasks:loaded.length,interrupted:loaded.filter(task=>task.status.stage==='interrupted').length,ready:loaded.filter(task=>task.status.archiveReady).length});
  }catch(e){this.available=false;this.error=`无法读取下载记录，原文件已保留：${(e as Error).message}`;await logEvent('downloads','download.records-unreadable',{},'error',e);}
 }
 status(){return this.tasks.map(task=>({...task.status,items:task.status.items.map(item=>({...item})),importedIds:[...task.status.importedIds]}));}
 hasActive(){return this.tasks.some(task=>!!task.running||activeStages.includes(task.status.stage));}
 private assertReady(){if(this.closed||!this.options.canStart())throw new Error('程序正在退出或安装更新，不能开始 Mod 任务。');if(!this.available)throw new Error(this.error);}
 private file(task:Task){return containedPath(this.options.cache,`${task.status.id}/${downloadFileName(task.status.fileName)}`);}
 private persist(){
  const file=path.join(this.options.cache,'tasks.json');const payload=JSON.stringify({version:1,tasks:this.tasks.map(task=>({status:task.status,modId:task.modId,urls:task.urls,binding:task.binding}))},null,2);
  if(Buffer.byteLength(payload)>16*1024**2)return Promise.reject(new Error('下载任务记录超过 16 MiB，原记录已保留，请备份后整理。'));
  const work=this.pending.then(()=>writeAtomicJson(file,payload));
  this.pending=work.catch(e=>{this.error=`下载任务记录保存失败：${e.message}`;});return work;
 }
 private async mark(task:Task,stage:ModDownload['stage'],message:string){task.status.stage=stage;task.status.message=message;task.status.updatedAt=new Date().toISOString();await this.persist();await logEvent('downloads','download.stage',{taskId:task.status.id,gameId:task.status.gameId,stage,receivedBytes:task.status.receivedBytes,totalBytes:task.status.totalBytes,archiveReady:task.status.archiveReady},stage==='error'?'error':stage==='partial'||stage==='interrupted'?'warning':'info');}
 private track(task:Task,work:()=>Promise<void>){
  if(task.running)throw new Error('该下载任务正在处理，请等待。');
  const run=work().catch(async e=>{if(!task.stopped){task.status.stage=e instanceof ModDirectoryChangedError?'waiting-directory':'error';task.status.message=task.failure||(e as Error).message;task.status.updatedAt=new Date().toISOString();if(!task.status.archiveReady)this.cancelItem(task);await this.persist().catch(()=>{});await logEvent('downloads','download.failed',{taskId:task.status.id,gameId:task.status.gameId,stage:task.status.stage},e instanceof ModDirectoryChangedError?'warning':'error',e);}}).finally(()=>{task.running=undefined;});
  task.running=run;return run;
 }
 private cancelItem(task:Task){try{task.item?.cancel();}catch{/* Native item may already be disposed after completion. */}}
 accept(item:DownloadItem,modId:number,urls:string[],gameId:GameId='zzz',updateTarget?:ModUpdateTarget){
  this.assertReady();
  if(!Object.hasOwn(GAMES,gameId))throw new Error('不支持的下载游戏。');
  if(!Number.isSafeInteger(modId)||modId<=0)throw new Error('请在具体 Mod 页面点击下载，无法确认当前下载来源。');
  if(!urls.length||urls.length>20)throw new Error('下载来源链无效。');urls.forEach(url=>gameBananaUrl(url,true));
  const filename=downloadFileName(item.getFilename());
  if(this.tasks.filter(task=>activeStages.includes(task.status.stage)).length>=3)throw new Error('已有 3 个活动下载任务，请等待完成。');
  if(this.tasks.length>=5000)throw new Error('下载记录已达上限，请保留记录后整理缓存。');
  if(item.getTotalBytes()>MAX_MOD_DOWNLOAD)throw new Error('下载包超过 2 GiB。');
  const time=new Date().toISOString();
  const task:Task={modId,urls:[...urls],stopped:false,item,controller:new AbortController(),status:{id:randomUUID(),gameId,purpose:updateTarget?'update':'new-install',...(updateTarget?{updateTarget}:{}),targetRoot:'',fileName:filename,title:'读取 Mod 信息…',stage:'binding',receivedBytes:0,totalBytes:Math.max(0,item.getTotalBytes()),archiveReady:false,message:'正在核对来源和保存目录…',importedIds:[],items:[],createdAt:time,updatedAt:time}};
  // Set synchronously in the native will-download callback; the website never chooses a path.
  item.setSavePath(this.file(task));this.tasks.push(task);
  const finished=new Promise<void>((resolve,reject)=>item.once('done',(_event,state)=>{task.status.receivedBytes=item.getReceivedBytes();if(state==='completed'){task.status.archiveReady=true;resolve();}else reject(new Error(task.failure||'下载已取消或中断，请重新下载。'));}));
  void finished.catch(()=>{});
  item.on('updated',(_event,state)=>{
   task.status.receivedBytes=item.getReceivedBytes();
   if(task.status.receivedBytes>MAX_MOD_DOWNLOAD||task.binding&&task.status.receivedBytes>task.binding.size){task.failure='下载大小超过网站记录或限制。';this.cancelItem(task);}
   else if(state==='interrupted'&&!task.stopped){task.failure='下载中断，请从任务重新下载。';this.cancelItem(task);}
  });
  void this.track(task,async()=>{
   task.status.targetRoot=updateTarget?.root||await this.options.root(gameId);if(task.stopped)return;await this.persist();if(task.stopped)return;
   task.binding=await resolveGameBananaFile(this.options.fetch,modId,urls,filename,task.controller!.signal,gameId);
   if(task.stopped)return;
   if(updateTarget?.candidateFingerprint&&createHash('sha256').update(JSON.stringify(task.binding)).digest('hex')!==updateTarget.candidateFingerprint)throw new Error('更新候选文件信息已改变，请重新检查。');
   task.status.title=task.binding.remote.title;task.status.character=task.binding.metadata.character||'';task.status.totalBytes=task.binding.size;
   await this.mark(task,'downloading','正在下载，完成后校验并等待安装…');await finished;
   if(task.stopped)return;
   await this.prepare(task);
  });
 }
 private async prepare(task:Task){
  this.assertReady();if(!task.binding||!task.status.archiveReady)throw new Error('没有可验证的完整下载包，请重读信息或重新下载。');
  await this.mark(task,'verifying','正在核对文件大小和网站摘要…');await verifyModDownload(this.file(task),task.binding);
  if(task.stopped)return;
  if(task.status.updateTarget?.candidateFingerprint&&createHash('sha256').update(JSON.stringify(task.binding)).digest('hex')!==task.status.updateTarget.candidateFingerprint)throw new Error('更新候选绑定已改变，请重新检查；压缩包保留。');
  const root=await this.options.root(task.status.gameId);
  if(!root||!task.status.targetRoot||path.resolve(root).toLowerCase()!==path.resolve(task.status.targetRoot).toLowerCase())throw new ModDirectoryChangedError();
  await this.mark(task,'ready',task.status.updateTarget?'候选包校验完成，等待确认替换指定 Mod。':task.binding.remote.checksum?'下载与校验完成，等待安装；安装后默认停用。':'下载完成，已核对大小（网站未提供摘要），等待安装。');
 }
 importSource(id:string){
  this.assertReady();const task=this.tasks.find(t=>t.status.id===id);
  if(!task||task.running||task.status.updateTarget||activeStages.includes(task.status.stage)||!task.binding||!task.status.archiveReady)throw new Error('请等待完整包与绑定准备完成；定向更新使用原替换入口。');
  const fingerprint=JSON.stringify([task.status.gameId,task.status.targetRoot,task.binding]);
  return {gameId:task.status.gameId,file:this.file(task),root:task.status.targetRoot,binding:structuredClone(task.binding),taskId:id,validate:async()=>{
    this.assertReady();if(task.running||task.status.updateTarget||!task.status.archiveReady||fingerprint!==JSON.stringify([task.status.gameId,task.status.targetRoot,task.binding]))throw new Error('下载任务或网站绑定已改变，请重新预检。');
    if(task.status.targetRoot!==await this.options.root(task.status.gameId)){await this.mark(task,'waiting-directory',new ModDirectoryChangedError().message);throw new ModDirectoryChangedError();}
  }};
 }
 async beginImport(id:string){
  this.assertReady();const task=this.tasks.find(t=>t.status.id===id);if(!task||task.running||task.status.updateTarget||activeStages.includes(task.status.stage)||!task.status.archiveReady||!task.binding)throw new Error('下载任务未准备好或正在提交。');
  await this.mark(task,'installing','正在提交已确认的导入计划；停止将在完整条目边界生效。');
 }
 async failImport(id:string,message:string){const task=this.tasks.find(t=>t.status.id===id);if(task&&!task.running&&task.status.stage!=='waiting-directory')await this.mark(task,'error',message+' 完整包已保留，请重新预检。');}
 async recordImport(id:string,result:import('../shared/import-workflows').ImportReceipt){
  const task=this.tasks.find(t=>t.status.id===id);if(!task||task.status.updateTarget)throw new Error('下载任务不存在。');
  const previous=task.status.items.filter(item=>item.ok&&item.id);const incoming=result.items.filter(item=>item.state!=='skipped').map(item=>({name:item.name,ok:item.ok,...(item.id!==undefined?{id:item.id}:{}),...(item.existing!==undefined?{existing:item.existing}:{}),...(item.error!==undefined?{error:item.error}:{})}));
  task.status.items=[...previous.filter(old=>!incoming.some(item=>item.id===old.id)),...incoming];task.status.importedIds=[...new Set([...task.status.importedIds,...result.importedIds])];
  const skipped=result.items.filter(i=>i.state==='skipped').length;
  const anyInstalled=task.status.items.some(i=>i.ok),stage:ModDownload['stage']=result.canceled?(anyInstalled?'partial':'interrupted'):result.errors.length?(anyInstalled?'partial':'error'):skipped?(anyInstalled?'partial':'ready'):'complete';
  await this.mark(task,stage,`本次新安装 ${result.importedIds.length} 项，默认停用；跳过 ${skipped} 项。${result.errors.join('；')}${skipped?' 未选条目可重新预检安装。':''}`);
 }
 async installPlan(id:string){
  this.assertReady();const task=this.tasks.find(task=>task.status.id===id);
  if(!task||task.running||activeStages.includes(task.status.stage)||!task.binding||!task.status.archiveReady)throw new Error('请等待完整包和网站信息准备完成，再选择安装位置。');
  let plan:ModDownloadInstallPlan|undefined;
  await this.track(task,async()=>{await this.prepare(task);if(task.stopped)return;plan=await this.options.plan(this.file(task),task.status.targetRoot,task.binding!,task.status.updateTarget);});
  if(!plan)throw new Error(task.status.message);return plan;
 }
 private async install(task:Task,destinations?:ModInstallDestination[]){
  await this.prepare(task);if(task.stopped)return;
  await this.mark(task,'installing',task.status.updateTarget?'正在确认并替换指定 Mod…':task.binding!.remote.checksum?'校验完成，正在安装为停用状态…':'已核对大小，网站未提供摘要；正在安装为停用状态…');
  const result=await this.options.install(this.file(task),task.status.targetRoot,task.binding!,destinations,task.status.updateTarget);
  task.status.importedIds=result.importedIds;task.status.items=result.items;
  const existing=result.items.filter(item=>item.existing).length;
  const stage=result.errors.length?(result.items.some(item=>item.ok)?'partial':'error'):'complete';
  await this.mark(task,stage,task.status.updateTarget?`已更新 ${result.items.filter(item=>item.ok).length} 项，身份与原启停状态保持。${result.errors.join('；')}`:`新安装 ${result.importedIds.length} 项，默认停用${existing?`；已有 ${existing} 项保持`:''}。${result.errors.length?' '+result.errors.join('\n'):''}`);
 }
 async action(id:string,action:ModDownloadAction,destinations?:ModInstallDestination[]){
  this.assertReady();const task=this.tasks.find(task=>task.status.id===id);
  if(!task||!['cancel','retry-download','retry-binding','retry-install','install-current','show-file'].includes(action))throw new Error('下载任务不存在或操作无效。');
  if(action==='show-file'){if(!task.status.archiveReady)throw new Error('下载包尚未完整保存。');await assertNoLinks(this.file(task));await fs.stat(this.file(task));this.options.showFile(this.file(task));return;}
  if(action==='cancel'){
   if(!['binding','downloading','verifying'].includes(task.status.stage))throw new Error('任务已经结束或正在提交安装，无法取消。');
   task.stopped=true;task.controller?.abort();this.cancelItem(task);await this.mark(task,'canceled','已取消，未开始安装。');return;
  }
  if(task.running||activeStages.includes(task.status.stage))throw new Error('该下载任务正在处理，请等待。');
  if(action==='retry-download'){
   const url=task.binding?.remote.downloadUrl||task.urls.find(value=>/^\/dl\/[1-9]\d*\/?$/.test(gameBananaUrl(value,true).pathname));
   if(!url)throw new Error('没有可重试的站点文件链接，请从 Mod 页面重新下载。');
   if(task.status.updateTarget)this.options.requestDownload(task.modId,url,task.status.gameId,task.status.updateTarget);else this.options.requestDownload(task.modId,url,task.status.gameId);return;
  }
  task.stopped=false;task.failure=undefined;task.controller=new AbortController();
  await this.track(task,async()=>{
   if(action==='retry-binding'){
    await this.mark(task,'binding','正在重新读取网站信息…');
    task.binding=await resolveGameBananaFile(this.options.fetch,task.modId,task.urls,task.status.fileName,task.controller!.signal,task.status.gameId);
    if(task.stopped)return;
    task.status.title=task.binding.remote.title;task.status.character=task.binding.metadata.character||'';task.status.totalBytes=task.binding.size;
    if(!task.status.archiveReady){await this.mark(task,'error','网站信息已重新读取，请点击重新下载获取完整压缩包。');return;}
   }else if(action==='install-current'){
    if(task.status.updateTarget)throw new Error('更新任务目标目录固定，目录改变后请重新检查更新；压缩包保留。');if(task.status.stage!=='waiting-directory')throw new Error('此任务未等待目录选择。');
    const root=await this.options.root(task.status.gameId);if(!root||!path.isAbsolute(root))throw new Error(`请先在设置中保存有效的${GAMES[task.status.gameId].name} Mod 目录。`);
    if(!await this.options.confirmRoot(task.status.targetRoot,root))return;
    this.assertReady();if(root!==await this.options.root(task.status.gameId))throw new ModDirectoryChangedError();
    task.status.targetRoot=root;
   }
   if(action==='retry-binding'||action==='install-current')await this.prepare(task);
   else await this.install(task,destinations);
  });
 }
 async close(){
  if(this.closed)return;this.closed=true;
  for(const task of this.tasks)if(['binding','downloading','verifying'].includes(task.status.stage)){task.stopped=true;task.controller?.abort();this.cancelItem(task);task.status.stage='interrupted';task.status.message='程序退出，任务已中断；下次可手动重试。';task.status.updatedAt=new Date().toISOString();}
  if(this.available)await this.persist().catch(()=>{});
  await Promise.allSettled(this.tasks.flatMap(task=>task.running?[task.running]:[]));await this.pending;
 }
}
