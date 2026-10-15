import {promises as fs,constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import type {GameId,GamePaths,LibrarySnapshot} from '../shared/contracts';
import type {ImportChoice,ImportPreview,ImportPreviewItem,ImportReceipt} from '../shared/import-workflows';
import {assertNoLinks,containedPath} from './archive';
import {ModService,clean,discover,safeName} from './mods';
import {inspectModTree,hashModTree} from './content-fingerprint';
import {isInside,optionalDigest,sha,fileBytes} from './inspection-files';
import {extractModArchive,inspectModArchive} from './mod-archive';
import {readDownloadBinding,verifyModDownload,ModDirectoryChangedError} from './gamebanana';
import type {GameBananaDownload} from './gamebanana';
import {writeAtomicJson} from './atomic-json';

const GiB=1024**3,MARGIN=64*1024**2,resources=new Set(['buffers','textures','meshes','shaders','shaderfixes','resources']);
const ini=(name:string)=>/\.ini$/i.test(name)&&!/^desktop\.ini$/i.test(name);
const uuid=(s:string)=>/^[a-f0-9-]{36}$/.test(s);
const same=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
interface SourceEvidence {file:string;directory:boolean;evidence:string;digest:string}
export interface DownloadImportSource {file:string;root:string;binding:GameBananaDownload;taskId?:string;validate?:()=>Promise<void>}
interface Candidate {item:ImportPreviewItem;directory:string}
interface Session {id:string;game:GameId;root:string;folder:string;expires:number;sources:SourceEvidence[];candidates:Candidate[];errors:string[];download?:DownloadImportSource;stop:boolean;committing:boolean;context:string;libraryTrees:Map<string,string>;warnings:string[]}
interface Plan {session:string;preview:ImportPreview;expires:number}
export class ImportPlanner {
 private sessions=new Map<string,Session>();private plans=new Map<string,Plan>();private running=new Map<GameId,{controller:AbortController;done:Promise<unknown>}>();private closed=false;
 // Replaceable for deterministic disk-space tests; unknown is never reported as sufficient.
 space=async(location:string):Promise<number|null>=>{try{const stat=await fs.statfs(location);return Number(stat.bavail)*Number(stat.bsize);}catch{return null;}};
 constructor(private data:string,private mods:ModService,private paths:(game:GameId)=>Promise<GamePaths>){}
 private cache(){return path.join(this.data,'import-preparations');}
 async initialize(){
  await assertNoLinks(this.cache());let names:string[];try{names=await fs.readdir(this.cache());}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  for(const id of names.filter(uuid)){const folder=containedPath(this.cache(),id);try{await assertNoLinks(folder);const file=path.join(folder,'owner.json'),stat=await fs.stat(file);if(stat.size>4096)continue;const owner=JSON.parse(await fs.readFile(file,'utf8'));if(owner.id===id&&['preparing','ready','committing'].includes(owner.phase))await writeAtomicJson(file,JSON.stringify({...owner,phase:'interrupted',message:'上次准备／提交已中断；不会自动安装，请重新预检。'}));}catch{/* Unidentified or changed caches are retained for inspection. */}}
 }
 hasActive(){return this.running.size>0||[...this.sessions.values()].some(s=>s.committing);}
 async close(){this.closed=true;for(const {controller}of this.running.values())controller.abort();for(const s of this.sessions.values())s.stop=true;await Promise.allSettled([...this.running.values()].map(r=>r.done));}
 private async owner(s:Session,phase:string){await assertNoLinks(s.folder);await writeAtomicJson(path.join(s.folder,'owner.json'),JSON.stringify({id:s.id,gameId:s.game,root:s.root,createdAt:new Date().toISOString(),phase}));}
 private async session(game:GameId,id:string){const s=this.sessions.get(id);if(!s||s.game!==game||s.expires<Date.now())throw new Error('导入准备已过期，请重新选择来源。');await assertNoLinks(s.folder);const owner=JSON.parse((await fileBytes(path.join(s.folder,'owner.json'),4096)).toString('utf8'));if(owner.id!==id||owner.gameId!==game||owner.root!==s.root)throw new Error('导入缓存归属不符，请重新预检。');return s;}
 async discard(game:GameId,id:string){const s=this.sessions.get(id);if(!s||s.game!==game)throw new Error('导入准备不存在。');if(s.committing){s.stop=true;return;}this.sessions.delete(id);for(const [token,p]of this.plans)if(p.session===id)this.plans.delete(token);await this.removeOwned(s);}
 private async removeOwned(s:Session){
  // FileOperations owns an independent incoming copy. Retain the source cache if
  // an interrupted ledger exists, rather than guessing that no recovery needs it.
  if((await this.mods.pending(s.game)).length)return;
  await assertNoLinks(s.folder);if(!same(path.dirname(s.folder),this.cache())||!uuid(path.basename(s.folder)))throw new Error('导入缓存范围无效。');
  const owner=JSON.parse((await fileBytes(path.join(s.folder,'owner.json'),4096)).toString('utf8'));if(owner.id!==s.id||owner.gameId!==s.game)throw new Error('导入缓存归属已改变，原内容保留。');
  await fs.rm(s.folder,{recursive:true});
 }
 private async context(game:GameId){
  const config=await this.paths(game);if(config.modsDirectory&&(isInside(this.data,config.modsDirectory)||isInside(config.modsDirectory,this.data)))throw new Error('Mod 根目录与管理器数据／准备缓存重叠，请设置独立目录。');const {data}=await this.mods.readonlyContext(game),library=await this.mods.readonlyScan(game);
  const stat=await fs.lstat(data.root);return {library,signature:sha(JSON.stringify([config,await optionalDigest(path.join(this.data,`library-${game}.json`)),stat.dev,stat.ino,library.mods.map(m=>[m.id,m.relativePath,m.remote]),data.groups]))};
 }
 private async sourceEvidence(file:string,signal?:AbortSignal):Promise<SourceEvidence>{
  signal?.throwIfAborted();await assertNoLinks(file);const stat=await fs.lstat(file);
  if(stat.isDirectory()){const tree=await hashModTree(file,{remaining:8*GiB},signal);return {file,directory:true,evidence:tree.evidence,digest:tree.hash.sha256};}
  if(!stat.isFile()||stat.size>2*GiB)throw new Error('来源不是普通文件夹或 2 GiB 内的压缩包。');
  const evidence=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':'),hash=createHash('sha256'),handle=await fs.open(file,'r');
  try{let bytes=0;for await(const chunk of handle.createReadStream({autoClose:false})){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>2*GiB)throw new Error('来源包超过 2 GiB。');hash.update(chunk);}const after=await handle.stat();if(evidence!==[after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(':'))throw new Error('来源在准备期间已改变。');}finally{await handle.close();}
  return {file,directory:false,evidence,digest:hash.digest('hex')};
 }
 private async safeSource(file:string){
  if(!path.isAbsolute(file))throw new Error('来源路径无效。');await assertNoLinks(file);
  const roots=[this.data,...(await Promise.all((['zzz','endfield'] as GameId[]).map(g=>this.paths(g)))).flatMap(p=>[p.modsDirectory,p.xxmiRoot,p.gameDirectory])].filter(Boolean);
  if(roots.some(root=>isInside(root,file)||isInside(file,root)))throw new Error('手动来源与游戏／加载器／Mod 库或管理器数据目录重叠，请选择独立来源。');
 }
 private async copy(source:string,target:string,signal:AbortSignal){
  const tree=await inspectModTree(source,signal);await fs.mkdir(target,{recursive:true});
  for(const file of tree.files){signal.throwIfAborted();const from=containedPath(source,file.relative),to=containedPath(target,file.relative);await assertNoLinks(from);await fs.mkdir(path.dirname(to),{recursive:true});await fs.copyFile(from,to,constants.COPYFILE_EXCL);}
  // Keep empty directories as well; they are still subject to link/path checks.
  let visited=0;const walk=async(from:string,to:string,depth=0)=>{if(depth>32||++visited>50000)throw new Error('来源目录在快照期间超出层级／节点预算。');for(const entry of await fs.readdir(from,{withFileTypes:true}))if(entry.isDirectory()){signal.throwIfAborted();await assertNoLinks(path.join(from,entry.name));await fs.mkdir(containedPath(to,entry.name),{recursive:true});await walk(path.join(from,entry.name),path.join(to,entry.name),depth+1);}};await walk(source,target);
 }
 async prepareLocal(game:GameId,files:string[],signal?:AbortSignal,progress?:(s:string)=>void){
  if(!Array.isArray(files)||!files.length||files.length>32||files.some(f=>typeof f!=='string'))throw new Error('一次请选择 1–32 个本地来源。');
  return this.prepare(game,files,undefined,signal,progress);
 }
 async prepareDownload(game:GameId,input:DownloadImportSource,signal?:AbortSignal,progress?:(s:string)=>void){
  const binding=readDownloadBinding(input.binding,game);await input.validate?.();if(!same(input.root,(await this.paths(game)).modsDirectory))throw new ModDirectoryChangedError();
 await verifyModDownload(input.file,binding);await input.validate?.();
  return this.prepare(game,[input.file],{...input,binding},signal,progress);
 }
 private async prepare(game:GameId,files:string[],download:DownloadImportSource|undefined,outer?:AbortSignal,progress?:(s:string)=>void){
  if(this.closed||this.running.has(game))throw new Error('已有导入准备正在运行或程序正在退出。');
  for(const s of [...this.sessions.values()])if(s.expires<Date.now()&&!s.committing)await this.discard(s.game,s.id);
  if(this.sessions.size>=20)throw new Error('导入准备已达 20 份，请关闭旧预检。');
  const controller=new AbortController(),abort=()=>controller.abort();outer?.addEventListener('abort',abort,{once:true});if(outer?.aborted)abort();
  const run=this.build(game,files,download,controller.signal,progress).finally(()=>{outer?.removeEventListener('abort',abort);this.running.delete(game);});this.running.set(game,{controller,done:run});return run;
 }
 private async build(game:GameId,files:string[],download:DownloadImportSource|undefined,signal:AbortSignal,progress?:(s:string)=>void){
  const {library,signature}=await this.context(game),id=randomUUID();await assertNoLinks(this.cache());await fs.mkdir(this.cache(),{recursive:true});const folder=containedPath(this.cache(),id);await fs.mkdir(folder);
  const s:Session={id,game,root:library.root,folder,expires:Date.now()+600000,sources:[],candidates:[],errors:[],download,stop:false,committing:false,context:signature,libraryTrees:new Map(),warnings:[]};await this.owner(s,'preparing');
  const budget={remaining:8*GiB};let nodes=0,preparedBytes=0;
  try{
   for(let index=0;index<files.length;index++){
    signal.throwIfAborted();const file=files[index],sourceFolder=path.join(folder,String(index));
    try{
     progress?.(`准备来源 ${index+1}/${files.length}：${path.basename(file)}`);if(!download)await this.safeSource(file);const evidence=await this.sourceEvidence(file,signal);let input:string;
     if(evidence.directory){const tree=await inspectModTree(file,signal);nodes+=tree.files.length;preparedBytes+=tree.bytes;if(preparedBytes>8*GiB)throw new Error('准备缓存超过 8 GiB 总预算。');await this.requireSpace(this.cache(),tree.bytes+MARGIN);input=path.join(sourceFolder,'payload');await this.copy(file,input,signal);if((await hashModTree(input,budget,signal)).hash.sha256!==evidence.digest)throw new Error('来源复制前后内容不同，请重新准备。');}
     else{const listing=await inspectModArchive(file,signal);nodes+=listing.files;const size=(await fs.stat(file)).size;preparedBytes+=size+listing.bytes;if(preparedBytes>8*GiB)throw new Error('准备缓存超过 8 GiB 总预算。');await this.requireSpace(this.cache(),size+listing.bytes+MARGIN);await fs.mkdir(sourceFolder,{recursive:true});const archive=path.join(sourceFolder,'source'+path.extname(file));await fs.copyFile(file,archive,constants.COPYFILE_EXCL);if((await this.sourceEvidence(archive,signal)).digest!==evidence.digest)throw new Error('压缩包复制期间发生变化。');input=path.join(sourceFolder,'payload');await extractModArchive(archive,input,signal);}
     if(nodes>200000)throw new Error('导入准备超过 200000 项预算。');const after=await this.sourceEvidence(file,signal);if(after.evidence!==evidence.evidence||after.digest!==evidence.digest)throw new Error('来源在准备期间已改变，请重新准备。');
     const tree=await inspectModTree(input,signal);if(tree.bytes>budget.remaining)throw new Error('准备缓存超过 8 GiB 总预算。');
     let paths=await discover(input);const entries=await fs.readdir(input,{withFileTypes:true}),rootIni=entries.some(e=>e.isFile()&&ini(e.name)),shared=entries.some(e=>e.isDirectory()&&resources.has(clean(e.name).toLowerCase())||e.isFile()&&/\.(dds|buf|vb|ib)$/i.test(e.name));
     const unclaimed=paths.length>0&&tree.files.some(file=>!paths.some(candidate=>file.relative.startsWith(candidate.replaceAll('\\','/')+'/'))&&!/^(?:__macosx\/|(?:readme|license|changelog)(?:[./]|$)|desktop\.ini$|\.ds_store$)/i.test(file.relative)&&!/^([^/]+\/)*[^/]+\.(txt|md|nfo|url)$/i.test(file.relative));
     const compound=paths.length>0&&(rootIni||shared||unclaimed);if(rootIni||(shared||unclaimed)&&tree.files.some(f=>ini(f.relative)))paths=[''];if(!paths.length)throw new Error('没有发现包含 INI 的 Mod。');if(s.candidates.length+paths.length>100)throw new Error('一次最多准备 100 个 Mod 条目。');
     const layout=await this.mods.importLayout(game,paths,path.basename(file),download?.binding);
     const built:Candidate[]=[];for(const relative of paths){signal.throwIfAborted();const directory=relative?containedPath(input,relative):input,name=safeName(clean(relative?path.basename(relative):path.basename(file,evidence.directory?'':path.extname(file))));const content=await hashModTree(directory,budget,signal),suggestion=layout.items[paths.indexOf(relative)];
      built.push({directory,item:{entryId:randomUUID(),source:path.basename(file),entryPath:relative.replaceAll('\\','/'),selected:true,folder:suggestion.folder,name,allowDuplicate:false,iniCount:(await inspectModTree(directory,signal)).files.filter(f=>ini(f.relative)).length,bytes:content.hash.bytes,files:content.hash.files,hash:content.hash,character:suggestion.character,category:suggestion.folder.split('/')[0]||'',reason:suggestion.character?'按条目、角色别名与网站信息建议；可修改':'角色不确定，请手动选择分类目录',compound,binding:!!download,duplicates:[],related:[],comparison:'complete',blockers:[]}});
     }
     s.sources.push(evidence);s.candidates.push(...built);
    }catch(error){signal.throwIfAborted();await assertNoLinks(sourceFolder);await fs.rm(sourceFolder,{recursive:true,force:true});s.errors.push(path.basename(file)+'：'+(error as Error).message);if((error as NodeJS.ErrnoException).code==='ENOSPC')break;}
   }
   if(!s.candidates.length)throw new Error(s.errors.join('\n')||'没有可导入的 Mod。');
   progress?.('比较当前库的完整内容');await this.compare(s,library,signal,progress);signal.throwIfAborted();if((await this.context(game)).signature!==signature)throw new Error('当前库或目录在准备期间已改变，请重新预检。');
   this.sessions.set(id,s);await this.owner(s,'ready');const preview=await this.plan(s);let changed=false;for(const item of preview.items)if(item.selected&&item.blockers.length){s.candidates.find(c=>c.item.entryId===item.entryId)!.item.selected=false;changed=true;}return changed?await this.plan(s):preview;
  }catch(error){this.sessions.delete(id);for(const [token,p]of this.plans)if(p.session===id)this.plans.delete(token);await this.owner(s,'interrupted').catch(()=>{});await this.removeOwned(s).catch(()=>{});throw error;}
 }
 private async compare(s:Session,library:LibrarySnapshot,signal:AbortSignal,progress?:(s:string)=>void){
  const budget={remaining:2*GiB};let nodes=0;const hashes=new Map<string,string>();
  for(const mod of library.mods){signal.throwIfAborted();try{const directory=containedPath(s.root,mod.relativePath),tree=await inspectModTree(directory,signal);nodes+=tree.files.length;if(nodes>200000)throw new Error('库比较超过 200000 文件预算。');s.libraryTrees.set(mod.relativePath,tree.evidence);
    const candidates=s.candidates.filter(c=>c.item.hash.structure===tree.structure);if(!candidates.length)continue;
    const digest=(await hashModTree(directory,budget,signal)).hash.sha256;hashes.set(mod.id,digest);
   }catch(error){signal.throwIfAborted();s.warnings.push('部分库内容未完成比较：'+(error as Error).message);for(const c of s.candidates)c.item.comparison='incomplete';if(nodes>200000)break;}
   if(nodes%32===0){progress?.(`已比较库内 ${s.libraryTrees.size} 项`);await new Promise(resolve=>setImmediate(resolve));}
  }
  const seen=new Map<string,Candidate>();for(const c of s.candidates){c.item.duplicates=library.mods.filter(m=>hashes.get(m.id)===c.item.hash.sha256).map(m=>({id:m.id,name:m.name}));const previous=seen.get(c.item.hash.sha256);if(previous)c.item.duplicates.push({id:'entry:'+previous.item.entryId,name:previous.item.name+'（本次来源）'});else seen.set(c.item.hash.sha256,c);
   const remote=s.download?.binding.remote;c.item.related=remote?library.mods.filter(m=>m.remote?.modId===remote.modId&&m.remote?.fileId===remote.fileId&&m.remote.entryPath===c.item.entryPath).map(m=>({id:m.id,name:m.name})):[];
   if(c.item.duplicates.length||c.item.related.length)c.item.selected=false;
  }s.warnings=[...new Set(s.warnings)].slice(0,20);
 }
 private async requireSpace(location:string,required:number){const available=await this.space(location);if(available!==null&&available<required)throw new Error('磁盘空间不足，需要 '+required+' 字节（含准备副本与余量）。');}
 private folder(value:string,library:LibrarySnapshot){
  if(typeof value!=='string'||value.length>4096||path.isAbsolute(value))throw new Error('安装目录必须是 Mod 根内的相对路径。');const parts=value?value.split(/[\\/]/).map(p=>safeName(p)):[];
  if(parts.some(p=>p.startsWith('.')||(resources.has(clean(p).toLowerCase())||clean(p).toLowerCase()==='__macosx')))throw new Error('不能安装到隐藏目录或资源目录。');const folder=parts.join(path.sep),target=folder?containedPath(library.root,folder):library.root;
  if(library.mods.some(m=>isInside(containedPath(library.root,m.relativePath),target)))throw new Error('不能把 Mod 安装到另一个 Mod 内部。');return folder;
 }
 private importName(value:string){let name=safeName(value);while(/^DISABLED/i.test(name))name=safeName(clean(name));if(name.startsWith('.')||resources.has(name.toLowerCase())||['__macosx','.git'].includes(name.toLowerCase()))throw new Error('Mod 名称不能是隐藏目录或资源目录名称，请改名。');return name;}
 private async plan(s:Session):Promise<ImportPreview>{
  const {library}=await this.context(s.game),items:ImportPreviewItem[]=[],targets=new Set<string>();
  for(const c of s.candidates){const item=structuredClone(c.item);item.blockers=[];try{item.name=this.importName(item.name);item.folder=this.folder(item.folder,library).replaceAll('\\','/');const relative=path.join(item.folder,'DISABLED_'+item.name),key=relative.normalize('NFC').toLowerCase();const parent=item.folder?containedPath(s.root,item.folder):s.root;await assertNoLinks(parent);try{const names=await fs.readdir(parent);if(names.some(name=>clean(name).normalize('NFC').toLowerCase()===item.name.normalize('NFC').toLowerCase()))item.blockers.push('目标已有同名或 Unicode 等价名称，必须改名／改目录或跳过。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}for(const name of [relative,path.join(item.folder,item.name)]){const target=containedPath(s.root,name);await assertNoLinks(target);try{await fs.lstat(target);item.blockers.push('目标已有同名 Mod，必须改名／改目录或跳过。');break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    if(item.selected){if(targets.has(key))item.blockers.push('本次选择之间存在同名目标。');targets.add(key);}
    if((item.duplicates.length||item.related.length)&&!item.allowDuplicate)item.blockers.push('重复内容或已有网站关联；另存需要明确接受。');
   }catch(error){item.blockers.push((error as Error).message);}items.push(item);}
  const bytes=items.filter(i=>i.selected).reduce((n,i)=>n+i.bytes,0),space:ImportPreview['space']=[{location:'cache',available:await this.space(this.cache()),required:0},{location:'target',available:await this.space(s.root),required:bytes+MARGIN}];
  const token=randomUUID(),preview:ImportPreview={kind:'mod-import',effect:'owned-cache',gameId:s.game,sessionId:s.id,token,root:s.root,expiresAt:new Date(Date.now()+120000).toISOString(),downloadTaskId:s.download?.taskId,folders:[],items,warnings:s.warnings,sourceErrors:s.errors,space,canCommit:!items.some(i=>i.selected&&i.blockers.length)&&space.every(v=>v.available===null||v.available>=v.required)};
  preview.folders=(await this.mods.importLayout(s.game,items.map(i=>i.entryPath||i.name),items[0].source,s.download?.binding)).folders;
  for(const [key,p]of this.plans)if(p.session===s.id)this.plans.delete(key);this.plans.set(token,{session:s.id,preview,expires:Date.now()+120000});return structuredClone(preview);
 }
 async revise(game:GameId,id:string,choices:ImportChoice[],signal?:AbortSignal,progress?:(s:string)=>void){
  const s=await this.session(game,id);if(s.committing)throw new Error('导入正在提交。');if(!Array.isArray(choices)||choices.length!==s.candidates.length||new Set(choices.map(c=>c?.entryId)).size!==choices.length||choices.some(c=>!c||typeof c.selected!=='boolean'||typeof c.allowDuplicate!=='boolean'||typeof c.folder!=='string'||typeof c.name!=='string'||!s.candidates.some(i=>i.item.entryId===c.entryId)))throw new Error('导入选择与准备条目不匹配。');
  progress?.('重新核对来源、库与目标');await this.verify(s,signal);for(const c of s.candidates){const choice=choices.find(i=>i.entryId===c.item.entryId)!;Object.assign(c.item,{selected:choice.selected,folder:choice.folder,name:choice.name,allowDuplicate:choice.allowDuplicate});}return this.plan(s);
 }
 private async verify(s:Session,signal?:AbortSignal,checkLibrary=true){
  if(this.closed||s.stop&&checkLibrary)throw new Error('导入已取消或程序正在退出。');await s.download?.validate?.();if(!same(s.root,(await this.paths(s.game)).modsDirectory))throw new ModDirectoryChangedError();
  await this.session(s.game,s.id);if(checkLibrary&&(await this.context(s.game)).signature!==s.context)throw new Error('库或目录在预检后已改变，请重新预检。');
  for(const source of s.sources){signal?.throwIfAborted();const current=checkLibrary?await this.sourceEvidence(source.file,signal):source.directory?{evidence:(await inspectModTree(source.file,signal)).evidence,digest:source.digest}:await this.sourceEvidence(source.file,signal);if(current.evidence!==source.evidence||current.digest!==source.digest)throw new Error('来源在预检后已改变，请重新准备。');}
  for(const [relative,evidence]of s.libraryTrees){signal?.throwIfAborted();if((await inspectModTree(containedPath(s.root,relative),signal)).evidence!==evidence)throw new Error('库内文件在预检后已改变，请重新预检。');}
  await s.download?.validate?.();
 }
 readPlan(game:GameId,token:string){const plan=this.plans.get(token);if(!plan||plan.preview.gameId!==game||plan.expires<Date.now())throw new Error('导入确认已过期，请更新预检。');return structuredClone(plan.preview);}
 async files(game:GameId,id:string,entryId:string,offset=0){const s=await this.session(game,id),c=s.candidates.find(c=>c.item.entryId===entryId);if(!c||!Number.isSafeInteger(offset)||offset<0)throw new Error('文件清单请求无效。');const tree=await inspectModTree(c.directory);return {offset,total:tree.files.length,files:tree.files.slice(offset,offset+100).map(f=>({path:f.relative,bytes:f.size}))};}
 async commit(game:GameId,token:string,acceptIncomplete:boolean):Promise<ImportReceipt>{
  const preview=this.readPlan(game,token),plan=this.plans.get(token)!,s=await this.session(game,plan.session);if(s.committing)throw new Error('导入正在提交。');if(!preview.canCommit)throw new Error('所选条目存在阻挡，请修改后更新预检。'+preview.items.filter(i=>i.selected).flatMap(i=>i.blockers).join('；'));
  if(typeof acceptIncomplete!=='boolean'||!acceptIncomplete&&(preview.space.some(v=>v.available===null)||preview.items.some(i=>i.selected&&i.comparison==='incomplete')))throw new Error('空间或内容比较未完成，需要明确接受估计边界。');
  await this.verify(s);const items:ImportReceipt['items']=[],ids:string[]=[];this.plans.delete(token);s.committing=true;await this.owner(s,'committing');
  try{
   await this.mods.scan(game);s.context=(await this.context(game)).signature;
   for(const item of preview.items){
    if(!item.selected){const duplicate=item.duplicates.find(d=>!d.id.startsWith('entry:'));items.push({entryId:item.entryId,id:duplicate?.id,name:item.name,ok:true,existing:!!duplicate,state:duplicate?'existing':'skipped',error:item.blockers.length?item.blockers.join('；'):undefined});continue;}
    if(s.stop||this.closed){items.push({entryId:item.entryId,name:item.name,ok:false,state:'interrupted',error:'已停止剩余项；请重新预检。'});continue;}
    try{await this.verify(s);await this.requireSpace(s.root,item.bytes+MARGIN);const c=s.candidates.find(c=>c.item.entryId===item.entryId)!;if((await hashModTree(c.directory)).hash.sha256!==item.hash.sha256)throw new Error('准备缓存内容已改变，请重新预检。');
     const id=await this.mods.commitPreparedImport(game,{root:s.root,source:c.directory,folder:item.folder,name:item.name,hash:item.hash,entryPath:item.entryPath,binding:s.download?.binding},async()=>{await this.verify(s,undefined,false);await this.requireSpace(s.root,MARGIN);});ids.push(id);items.push({entryId:item.entryId,id,name:item.name,ok:true,state:'imported'});s.context=(await this.context(game)).signature;
    }catch(error){const message=(error as Error).message,interrupted=(s.stop||this.closed)&&message==='导入已取消或程序正在退出。';items.push({entryId:item.entryId,name:item.name,ok:false,state:interrupted?'interrupted':'failed',error:message});s.stop=true;}
   }
   await this.owner(s,'finished');const library=await this.mods.scan(game);for(const item of items)if(item.id?.startsWith('unindexed:'))item.id=library.mods.find(m=>m.relativePath===item.id!.slice(10))?.id;return {sessionId:s.id,library,importedIds:ids,items,errors:[...s.errors,...items.filter(i=>!i.ok).map(i=>i.name+'：'+i.error)],canceled:s.stop&&!items.some(item=>item.state==='failed')};
  }finally{s.committing=false;}
 }
}
