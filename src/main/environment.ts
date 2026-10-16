import {logOperationReference} from './operation-log';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {GameId,GamePaths} from '../shared/contracts';
import {GAMES} from '../shared/contracts';
import type {EnvironmentCandidate,EnvironmentReport,EnvironmentScope,EnvironmentRepairRequest,EnvironmentRepairPreview,EnvironmentRepairReceipt,EnvironmentRepairRecord} from '../shared/environment';
import {SettingsStore,validateSettings} from './settings';
import {assertNoLinks,containedPath} from './archive';
import {fileBytes,optionalDigest,sha,isInside} from './inspection-files';
import {writeAtomicFile,writeAtomicJson} from './atomic-json';
import {inspectXXMI,resolveLoaderPath,parseRecursiveIncludes} from './xxmi';
import {resolveGameInstallation,requireGameExecutable} from './game-paths';
import {decodeIni} from './ini';
import {parseUniqueJson} from './preset-package';
import {patchFirstRecursiveInclude,versionAtLeast} from './sync';
import type {ReadJobs} from './read-jobs';

type Scope=EnvironmentScope;
type Change={kind:'config'|'ini';before:Buffer;after:Buffer;target:string};
type Owner={version:1;id:string;game:GameId;scope:Scope;before:GamePaths;after:GamePaths;iniRelative:string;createdAt:string;files:{kind:'config'|'ini';before:string;after:string}[]};
type Journal={version:1;id:string;ownerDigest:string;phase:EnvironmentRepairRecord['phase'];message:string};
type RollbackState={paths:GamePaths;digests:string[]};
type Plan={preview:EnvironmentRepairPreview;before:GamePaths;after:GamePaths;files:Change[];fingerprint:string;resultId?:string;candidateId?:string;repairId?:string};
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const normalize=(v:string)=>v?path.resolve(v).toLowerCase():'';
const object=(v:any)=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Launcher 配置结构未知，未自动修改。');return v as Record<string,any>;};
function encodeLike(bytes:Buffer,text:string){const d=decodeIni(bytes);let body=Buffer.from(text,d.encoding.startsWith('UTF-16')?'utf16le':'utf8');if(d.encoding==='UTF-16 BE')body=body.swap16();return Buffer.concat([d.bom,body]);}
export class GameEnvironmentService {
 private reports=new Map<string,{report:EnvironmentReport;fingerprint:string;expires:number}>();
 private plans=new Map<string,Plan>();private active=false;private closing=false;
 constructor(private data:string,private store:SettingsStore,private jobs:ReadJobs,private step?:(phase:string)=>Promise<void>){}
 hasActive(){return this.active;}
 close(){this.closing=true;}
 private game(game:GameId){if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');}
 private folder(game:GameId,id?:string){this.game(game);if(id!==undefined&&!uuid(id))throw new Error('环境修复记录身份无效。');return path.join(this.data,'environment-repairs',game,...(id?[id]:[]));}
 private prune(){for(const [id,v]of this.reports)if(v.expires<Date.now())this.reports.delete(id);for(const [id,v]of this.plans)if(Date.parse(v.preview.expiresAt)<Date.now())this.plans.delete(id);while(this.reports.size>20)this.reports.delete(this.reports.keys().next().value!);while(this.plans.size>20)this.plans.delete(this.plans.keys().next().value!);}
 private async fileEvidence(file:string){try{await assertNoLinks(file);const s=await fs.stat(file,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}catch(e){return 'unavailable:'+(e as NodeJS.ErrnoException).code;}}
 private async fingerprint(game:GameId,candidates:EnvironmentCandidate[]=[]){const fields=(await this.store.read()).games[game];const roots=[...new Set([fields.xxmiRoot,...candidates.map(c=>c.paths.xxmiRoot)].filter(Boolean))],values:unknown[]=[fields];for(const root of roots){values.push([root,await this.fileEvidence(path.join(root,'Resources','Bin','XXMI Launcher.exe'))]);try{const inspection=await inspectXXMI(game,root);values.push([await optionalDigest(path.join(root,'XXMI Launcher Config.json')),await optionalDigest(inspection.iniPath)]);}catch{values.push('unreadable');}}for(const c of candidates)values.push([c.id,c.paths,await this.fileEvidence(c.executable||c.paths.gameDirectory)]);return sha(JSON.stringify(values));}
 async start(game:GameId,mode:'quick'|'discover',selection?:{kind:'game'|'loader';directory:string}){
  this.game(game);if(!['quick','discover'].includes(mode))throw new Error('环境检查模式无效。');const paths=(await this.store.read()).games[game];let current:EnvironmentReport|undefined;
  return this.jobs.start('environment',game,paths,async(signal,progress)=>{current=await this.check(game,mode,selection,signal,progress);return current;},async()=>!!current&&this.reports.get(current.resultId)?.fingerprint===await this.fingerprint(game,current.candidates),JSON.stringify([mode,selection]));
 }
 async check(game:GameId,mode:'quick'|'discover',selection?:{kind:'game'|'loader';directory:string},signal?:AbortSignal,progress:(s:string)=>void=()=>{}):Promise<EnvironmentReport>{
  this.game(game);this.prune();const paths={...(await this.store.read()).games[game]},issues:string[]=[],candidates:EnvironmentCandidate[]=[];
  if(selection&&!['game','loader'].includes(selection.kind))throw new Error('选择类型无效。');
  const loaderRoot=selection?.kind==='loader'?selection.directory:paths.xxmiRoot;
  let installation:Awaited<ReturnType<typeof inspectXXMI>>|undefined;try{installation=await inspectXXMI(game,loaderRoot);}catch{issues.push('XXMI 位置不可读或尚未配置。');}
  progress('核对游戏路径和 Launcher 目标');signal?.throwIfAborted();
  const roots=[{root:paths.gameDirectory,source:'已保存游戏目录'}];
  if(mode==='discover'&&installation?.gameDirectory&&normalize(installation.gameDirectory)!==normalize(paths.gameDirectory))roots.push({root:installation.gameDirectory,source:'当前 Launcher 配置'});
  if(selection?.kind==='game')roots.unshift({root:selection.directory,source:'本次原生选择'});
  if(mode==='discover')try{const h=JSON.parse((await fileBytes(path.join(this.data,'environment-'+game+'.json'))).toString());if(h.version===1&&typeof h.gameDirectory==='string'&&path.isAbsolute(h.gameDirectory))roots.push({root:h.gameDirectory,source:'上次明确采用的位置'});}catch{/* Optional observations never replace saved settings. */}
  let complete=true,savedExecutable='';const scanned=new Set<string>();let budget=10000;const deadline=Date.now()+5000;
  for(const {root,source}of roots){signal?.throwIfAborted();if(!root||scanned.has(normalize(root)))continue;scanned.add(normalize(root));if(isInside(this.data,root)||normalize(root)===normalize(paths.modsDirectory)){issues.push('未将管理器数据或 Mod 根作为游戏搜索位置。');complete=false;continue;}
   const resolution=await resolveGameInstallation(game,root,{signal,maxEntries:Math.max(0,budget),timeoutMs:Math.max(0,deadline-Date.now()),quick:mode==='quick'});budget-=resolution.visited;complete&&=resolution.complete;issues.push(...resolution.issues);
   if(normalize(root)===normalize(paths.gameDirectory)&&resolution.complete&&resolution.matches.length===1)savedExecutable=resolution.matches[0].executable;
   for(const m of resolution.matches){const fields={...paths,xxmiRoot:loaderRoot||paths.xxmiRoot,gameDirectory:m.directory};if(candidates.some(c=>normalize(c.executable)===normalize(m.executable)&&normalize(c.paths.xxmiRoot)===normalize(fields.xxmiRoot)))continue;
    candidates.push({id:randomUUID(),kind:'game',name:path.basename(m.executable)+(m.executable.toLowerCase().includes('beta')?'（测试版本）':''),source,paths:fields,executable:m.executable});}
   if(mode==='discover'&&!resolution.matches.length)issues.push(source+'：没有确认有效游戏 EXE。');if(resolution.matches.length>1)issues.push(source+'：存在多个候选，请明确选择独立安装目录。');
  }
  if(installation?.installed){candidates.push({id:randomUUID(),kind:selection?.kind==='loader'?'loader':'current',name:selection?.kind==='loader'?'采用所选 XXMI 外层根':'保持已保存目录',source:selection?.kind==='loader'?'本次原生选择':'当前设置',paths:{...paths,xxmiRoot:loaderRoot},executable:savedExecutable});}
  const repairs:EnvironmentRepairRecord[]=[];let pending=false;try{for(const r of await this.history(game)){repairs.push(r);pending||=['pending','prepared','working'].includes(r.phase);}}catch{pending=true;issues.push('环境修复记录不可读，原文保留；暂停环境写入，请查看记录位置。');}
  try{for(const other of Object.keys(GAMES)as GameId[])if(other!==game&& (await this.history(other)).some(r=>['pending','prepared','working'].includes(r.phase)))pending=true;}catch{pending=true;issues.push('其它游戏的环境修复记录需检查；共享 Launcher 操作暂缓。');}
  let syncSchema=false;try{const config=object(parseUniqueJson(Buffer.from(decodeIni(await fileBytes(path.join(loaderRoot,'XXMI Launcher Config.json'))).text))),importer=object(object(object(config.Importers)[GAMES[game].importer]).Importer);syncSchema=!importer.custom_launch&&!importer.run_pre_launch_enabled&&!importer.run_post_load_enabled;}catch{}
  let manageMods=false;try{await assertNoLinks(paths.modsDirectory);manageMods=(await fs.stat(paths.modsDirectory)).isDirectory();}catch{}
  const matched=!!installation?.installed&&normalize(installation.gameDirectory)===normalize(paths.gameDirectory);
  if(installation?.installed&&paths.modsDirectory&&!installation.modsDirectories.some(d=>normalize(d)===normalize(paths.modsDirectory)))issues.push('当前 Mod 库尚未确认在 loader 读取范围，可独立预览静态规则修复。');
  if(!matched)issues.push('已保存游戏位置与 Launcher 未完全匹配；修复后重新检查。');
  if(pending)issues.push('存在未完成环境修复，请先预览回退。');
  const launch=!!savedExecutable&&matched&&complete&&!pending;
  const report:EnvironmentReport={kind:'environment',resultId:randomUUID(),gameId:game,paths,observedAt:new Date().toISOString(),state:pending?'transient':launch?'healthy':!matched&&candidates.some(c=>c.kind==='game')?'change-detected':candidates.some(c=>c.kind==='game')?'needs-selection':!complete?'unknown':'unavailable',loader:{installed:!!installation?.installed,gameDirectory:installation?.gameDirectory??'',modsDirectories:installation?.modsDirectories??[]},candidates,issues:[...new Set(issues)],complete,executable:savedExecutable,capabilities:{manageMods,launch,refresh:launch,sync:!!installation?.installed&&syncSchema&&!pending},repairs};
  const fingerprint=await this.fingerprint(game,candidates);this.reports.set(report.resultId,{report:structuredClone(report),fingerprint,expires:Date.now()+600000});this.prune();return report;
 }
 private async journal(game:GameId,id:string){const dir=this.folder(game,id);await assertNoLinks(dir);const ownerBytes=await fileBytes(path.join(dir,'owner.json')),value=JSON.parse((await fileBytes(path.join(dir,'manifest.json'))).toString()) as Journal,owner=JSON.parse(ownerBytes.toString()) as Owner;
  if(typeof value.message!=='string'||value.message.length>4000||value.version!==1||value.id!==id||value.ownerDigest!==sha(ownerBytes)||!['prepared','working','complete','rolled-back','pending'].includes(value.phase)||owner.version!==1||owner.id!==id||owner.game!==game||!['save','sync-game','sync-mods'].includes(owner.scope)||!Array.isArray(owner.files)||owner.files.length>2||typeof owner.createdAt!=='string'||!Number.isFinite(Date.parse(owner.createdAt)))throw new Error('环境修复记录损坏，原文保留。');
  const settings=await this.store.read();validateSettings({...settings,games:{...settings.games,[game]:owner.before}});validateSettings({...settings,games:{...settings.games,[game]:owner.after}});
  if(owner.before.modsDirectory!==owner.after.modsDirectory||new Set(owner.files.map(f=>f.kind)).size!==owner.files.length||owner.files.some(f=>!['config','ini'].includes(f.kind)||!/^[a-f0-9]{64}$/.test(f.before)||!/^[a-f0-9]{64}$/.test(f.after))||owner.scope==='save'&&owner.files.length||owner.scope!=='sync-mods'&&owner.files.some(f=>f.kind==='ini'))throw new Error('环境修复记录范围无效。');
  const files:Change[]=[];for(const f of owner.files){const target=f.kind==='config'?path.join(owner.after.xxmiRoot,'XXMI Launcher Config.json'):containedPath(owner.after.xxmiRoot,owner.iniRelative);if(f.kind==='ini'&&path.basename(target).toLowerCase()!=='d3dx.ini')throw new Error('修复文件类型不符。');if(!owner.after.xxmiRoot||path.resolve(owner.after.xxmiRoot)===path.parse(owner.after.xxmiRoot).root||!isInside(owner.after.xxmiRoot,target)||normalize(target)===normalize(owner.after.xxmiRoot))throw new Error('修复记录目标超出受控范围。');const before=await fileBytes(path.join(dir,f.kind+'.before'),4*1024**2),after=await fileBytes(path.join(dir,f.kind+'.after'),4*1024**2);if(sha(before)!==f.before||sha(after)!==f.after)throw new Error('环境修复副本摘要不符，原文保留。');files.push({kind:f.kind,target,before,after});}
  return {dir,owner,value,files};
 }
 private summary(owner:Owner,value:Journal):EnvironmentRepairRecord{return {id:owner.id,gameId:owner.game,phase:value.phase,createdAt:owner.createdAt,scope:owner.scope,message:value.message};}
 async history(game:GameId){const folder=this.folder(game);await assertNoLinks(folder);let entries:string[];try{entries=await fs.readdir(folder);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}if(entries.length>100)throw new Error('环境修复记录超过预算，请保留现场并整理。');const results:EnvironmentRepairRecord[]=[];for(const id of entries){if(!uuid(id))throw new Error('存在未知环境修复资料，请保留现场。');const r=await this.journal(game,id);results.push(this.summary(r.owner,r.value));}return results.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 async assertReady(game:GameId,external=false,except?:string){this.game(game);for(const id of external?Object.keys(GAMES)as GameId[]:[game])for(const r of await this.history(id))if(r.id!==except&&['prepared','working','pending'].includes(r.phase))throw new Error('存在未完成环境修复，请先到路径设置的“检查与修复”预览回退。');}
 private async safeTarget(game:GameId,root:string,target:string,inspect=true){const settings=await this.store.read();if(!root||!path.isAbsolute(root)||path.parse(root).root===path.resolve(root)||!isInside(root,target)||normalize(root)===normalize(target)||isInside(this.data,target)||Object.values(settings.games).some(g=>g.modsDirectory&&isInside(g.modsDirectory,target)||g.gameDirectory&&isInside(g.gameDirectory,target)))throw new Error('环境修复目标超出受控范围。');await assertNoLinks(target);if(!inspect)return;const installation=await inspectXXMI(game,root);if(!installation.installed)throw new Error('目标不是完整的所选 XXMI 安装。');}
 private async filePlan(game:GameId,fields:GamePaths,scope:Scope):Promise<Change[]>{if(scope==='save')return [];await requireGameExecutable(game,fields.gameDirectory);const installation=await inspectXXMI(game,fields.xxmiRoot);if(!installation.installed)throw new Error('请选择完整的 XXMI 安装。');const target=path.join(fields.xxmiRoot,'XXMI Launcher Config.json');await this.safeTarget(game,fields.xxmiRoot,target);
  const before=await fileBytes(target),text=decodeIni(before).text,config=object(parseUniqueJson(Buffer.from(text))),importer=object(object(object(config.Importers)[GAMES[game].importer]).Importer);if(importer.custom_launch||importer.run_pre_launch_enabled||importer.run_post_load_enabled)throw new Error('存在自定义启动/脚本配置，请在官方 Launcher 中确认；未自动修改。');
  const resolved=resolveLoaderPath(fields.xxmiRoot,typeof importer.importer_folder==='string'?importer.importer_folder:GAMES[game].importer);if(normalize(resolved)!==normalize(installation.importerDirectory))throw new Error('Importer 目录结构无法确认。');
  importer.game_folder=fields.gameDirectory;const files:Change[]=[];
  if(scope==='sync-mods'){
   await this.safeTarget(game,fields.xxmiRoot,installation.iniPath);if(!fields.modsDirectory)throw new Error('请先保存有效的 Mod 目录。');await assertNoLinks(fields.modsDirectory);if(!(await fs.stat(fields.modsDirectory)).isDirectory())throw new Error('Mod 目录不可用。');const ini=await fileBytes(installation.iniPath,4*1024**2),decoded=decodeIni(ini),includes=parseRecursiveIncludes(decoded.text);const headings=decoded.text.split(/\r\n|\n|\r/).filter(l=>/^\s*\[include\]\s*(?:;.*)?$/i.test(l));
   if(headings.length!==1||includes.length!==1||/[\${}*?]|^if\b/i.test(includes[0]))throw new Error('存在多个或动态读取规则，请在 Launcher 中手动确认。');
   const manifest=JSON.parse((await fileBytes(path.join(fields.xxmiRoot,'Resources','Packages','XXMI','Manifest.json'))).toString());if(typeof manifest.version!=='string'||!/^\d+\.\d+\.\d+$/.test(manifest.version)||!versionAtLeast(manifest.version,'1.2.0'))throw new Error('读取目录修复需要已确认的 XXMI 1.2.0 或更新版本。');
   const overrides=importer.d3dx_ini===undefined?importer.d3dx_ini={}:object(importer.d3dx_ini),core=overrides.core===undefined?overrides.core={}:object(overrides.core),include=core.Include===undefined?core.Include={}:object(core.Include);include.include_recursive=fields.modsDirectory;
   const after=encodeLike(ini,patchFirstRecursiveInclude(decoded.text,fields.modsDirectory));if(!ini.equals(after))files.push({kind:'ini',target:installation.iniPath,before:ini,after});
  }
  const newline=text.includes('\r\n')?'\r\n':'\n',after=encodeLike(before,JSON.stringify(config,null,2).replace(/\n/g,newline));if(!before.equals(after))files.push({kind:'config',target,before,after});return files;
 }
 async prepare(game:GameId,request:EnvironmentRepairRequest):Promise<EnvironmentRepairPreview>{this.game(game);this.prune();if(this.closing)throw new Error('程序正在退出。');let before:GamePaths,after:GamePaths,files:Change[],scope:Scope,fingerprint='',repairId:string|undefined;
  if(request?.kind==='rollback'){const r=await this.journal(game,request.repairId);if(r.value.phase==='rolled-back')throw new Error('此记录已经回退。');const state=await this.assertRollback(game,r.owner,r.files);before=state.paths;after=r.owner.before;files=r.files.filter((f,i)=>state.digests[i]!==sha(f.before));scope=r.owner.scope;repairId=r.owner.id;fingerprint=sha(JSON.stringify([r.value,state]));}
  else if(request?.kind==='repair'){
   await this.assertReady(game,true);if(!['save','sync-game','sync-mods'].includes(request.scope))throw new Error('修复范围无效。');const r=this.reports.get(request.resultId),c=r?.report.candidates.find(c=>c.id===request.candidateId);if(!r||!c||r.report.gameId!==game||r.fingerprint!==await this.fingerprint(game,r.report.candidates))throw new Error('环境或候选已变化，请重新检查。');
   before={...(await this.store.read()).games[game]};after={...c.paths};scope=request.scope;
   if(after.modsDirectory!==before.modsDirectory)throw new Error('路径修复不迁移 Mod 根。');validateSettings({...await this.store.read(),games:{...(await this.store.read()).games,[game]:after}});
   if(c.kind==='game')await requireGameExecutable(game,after.gameDirectory);else if(!(await inspectXXMI(game,after.xxmiRoot)).installed)throw new Error('所选 XXMI 安装不可用。');
   if(/[\r\n\0;"*?]/.test(after.gameDirectory)||/[\r\n\0;"*?]/.test(after.modsDirectory))throw new Error('路径包含不能安全写入的字符。');files=await this.filePlan(game,after,scope);fingerprint=r.fingerprint;
  }else throw new Error('环境修复请求无效。');
  const changes:EnvironmentRepairPreview['changes']=(['gameDirectory','xxmiRoot']as const).filter(k=>before[k]!==after[k]).map(k=>({role:k,before:before[k],after:after[k]}));
  for(const f of files){
   const oldBytes=request.kind==='rollback'?f.after:f.before,newBytes=request.kind==='rollback'?f.before:f.after;
   if(f.kind==='config'){
    const publicValues=(bytes:Buffer)=>{const importer=object(object(object(object(parseUniqueJson(Buffer.from(decodeIni(bytes).text))).Importers)[GAMES[game].importer]).Importer);return {game_folder:typeof importer.game_folder==='string'?importer.game_folder:'',include_recursive:typeof importer.d3dx_ini?.core?.Include?.include_recursive==='string'?importer.d3dx_ini.core.Include.include_recursive:''};};
    const old=publicValues(oldBytes),next=publicValues(newBytes);for(const key of ['game_folder','include_recursive']as const)if(old[key]!==next[key])changes.push({role:'Launcher.'+key,before:old[key],after:next[key]});
   }else changes.push({role:'d3dx.ini include_recursive',before:parseRecursiveIncludes(decodeIni(oldBytes).text).join('；'),after:parseRecursiveIncludes(decodeIni(newBytes).text).join('；')});
  }
  const preview:EnvironmentRepairPreview={token:randomUUID(),gameId:game,action:request.kind==='rollback'?'rollback':'repair',expiresAt:new Date(Date.now()+120000).toISOString(),scope,changes,warnings:['Mod 根、文件、预设和兼容性标记保持；游戏更新后的兼容性需要实际测试。',scope==='save'?'仅保存路径，不改 Launcher；之后检查是否需要同步。':'只修改所选游戏公开路径/明确静态规则；旧配置原字节保存为恢复副本。'],...(repairId?{repairId}:{})};
  this.plans.set(preview.token,{preview,before,after,files,fingerprint,...(request.kind==='repair'?{resultId:request.resultId,candidateId:request.candidateId}:{repairId})});this.prune();return structuredClone(preview);
 }
 readPlan(game:GameId,token:string){const p=this.plans.get(token);if(!p||p.preview.gameId!==game||Date.parse(p.preview.expiresAt)<Date.now())throw new Error('环境修复预览已过期，请重新预览。');return structuredClone(p.preview);}
 private async assertRollback(game:GameId,owner:Owner,files:Change[]):Promise<RollbackState>{
  const fields=(await this.store.read()).games[game];
  if(!same(fields,owner.before)&&!same(fields,owner.after))throw new Error('游戏路径在修复后被改过，保留现场，不能自动回退。');
  const digests:string[]=[];
  for(const f of files){
   await this.safeTarget(game,owner.after.xxmiRoot,f.target,false);
   const digest=await optionalDigest(f.target);
   if(digest!==sha(f.before)&&digest!==sha(f.after))throw new Error('外部配置已被其它操作修改，保留两侧副本，不能自动覆盖。');
   digests.push(digest);
  }
  return {paths:fields,digests};
 }
 private async rollback(game:GameId,owner:Owner,files:Change[],expected?:RollbackState){
  const state=await this.assertRollback(game,owner,files);
  if(expected&&!same(expected,state))throw new Error('回退预览后环境发生变化，请重新预览。');
  for(let i=files.length-1;i>=0;i--){const f=files[i];if(state.digests[i]!==sha(f.before))await writeAtomicFile(f.target,f.before,sha(f.after));}
  await this.store.saveGamePathsIfCurrent(game,state.paths,owner.before);
  for(const f of files)if(await optionalDigest(f.target)!==sha(f.before))throw new Error('回退期间外部配置发生变化，原文和副本保留。');
  if(!same((await this.store.read()).games[game],owner.before))throw new Error('回退期间游戏路径发生变化，原设置保留。');
 }

 async apply(game:GameId,token:string):Promise<EnvironmentRepairReceipt>{const p=this.plans.get(token);this.readPlan(game,token);if(!p||this.active||this.closing)throw new Error('环境修复正在执行或程序正在退出。');this.active=true;let created:Awaited<ReturnType<GameEnvironmentService['journal']>>|undefined;
  try{
   if(p.repairId){
    const r=await this.journal(game,p.repairId),state=await this.assertRollback(game,r.owner,r.files);
    if(r.value.phase==='rolled-back'||p.fingerprint!==sha(JSON.stringify([r.value,state])))throw new Error('回退预览后环境或记录发生变化，请重新预览。');
    await this.assertReady(game,true,r.owner.id);await logOperationReference(this.data,game,'environment-repair',r.owner.id);
    // Publish rollback intent before the first external write, so a crash cannot leave a complete label.
    r.value.phase='working';r.value.message='正在回退环境修改；中断后需重新预览回退。';await writeAtomicJson(path.join(r.dir,'manifest.json'),JSON.stringify(r.value));this.plans.delete(token);this.reports.clear();
    try{
     await this.rollback(game,r.owner,r.files,state);
     r.value.phase='rolled-back';r.value.message='已核对并回退本次环境修改，其它配置保持。';
     await writeAtomicJson(path.join(r.dir,'manifest.json'),JSON.stringify(r.value));
    }catch(error){
     r.value.phase='pending';r.value.message='回退尚未完成，原文和副本保留；请重新预览回退。';
     await writeAtomicJson(path.join(r.dir,'manifest.json'),JSON.stringify(r.value)).catch(()=>{});
     throw new Error((error as Error).message+' 回退尚未完成，请重新预览；副本已保留。');
    }
    return {gameId:game,repair:this.summary(r.owner,r.value),settings:await this.store.read(),warnings:[]};
   }
   await this.assertReady(game,true);const r=this.reports.get(p.resultId!),c=r?.report.candidates.find(c=>c.id===p.candidateId);if(!r||!c||p.fingerprint!==await this.fingerprint(game,r.report.candidates)||!same((await this.store.read()).games[game],p.before))throw new Error('预览后环境或配置改变，请重新检查。');
   const candidateEvidence=c.executable?await this.fileEvidence(c.executable):'';if(c.kind==='game')await requireGameExecutable(game,p.after.gameDirectory);
   const fresh=await this.filePlan(game,p.after,p.preview.scope);if(fresh.length!==p.files.length||fresh.some((f,i)=>f.target!==p.files[i].target||!f.before.equals(p.files[i].before)||!f.after.equals(p.files[i].after)))throw new Error('外部配置在预览后改变，请重新预览。');
   const id=randomUUID(),dir=this.folder(game,id),staging=path.join(this.data,'environment-staging',game,id),installation=await inspectXXMI(game,p.after.xxmiRoot).catch(()=>undefined);await assertNoLinks(dir);await assertNoLinks(staging);await fs.mkdir(staging,{recursive:true});
   const owner:Owner={version:1,id,game,scope:p.preview.scope,before:p.before,after:p.after,iniRelative:installation?path.relative(p.after.xxmiRoot,installation.iniPath):'',createdAt:new Date().toISOString(),files:p.files.map(f=>({kind:f.kind,before:sha(f.before),after:sha(f.after)}))};
   for(const f of p.files){await fs.writeFile(path.join(staging,f.kind+'.before'),f.before,{flag:'wx',mode:0o600});await fs.writeFile(path.join(staging,f.kind+'.after'),f.after,{flag:'wx',mode:0o600});}
   const ownerText=JSON.stringify(owner);await fs.writeFile(path.join(staging,'owner.json'),ownerText,{flag:'wx',mode:0o600});const value:Journal={version:1,id,ownerDigest:sha(ownerText),phase:'prepared',message:'已保存修复范围与原字节，尚未完成提交。'};await writeAtomicJson(path.join(staging,'manifest.json'),JSON.stringify(value));await fs.mkdir(path.dirname(dir),{recursive:true});await fs.rename(staging,dir);created={dir,owner,value,files:p.files};await logOperationReference(this.data,game,'environment-repair',id);this.plans.delete(token);
   value.phase='working';await writeAtomicJson(path.join(dir,'manifest.json'),JSON.stringify(value));await this.step?.('prepared');
   for(const f of p.files){await writeAtomicFile(f.target,f.after,sha(f.before));await this.step?.(f.kind);}
   await this.store.saveGamePathsIfCurrent(game,p.before,p.after);await this.step?.('settings');
   if(p.preview.scope!=='save'){const check=await inspectXXMI(game,p.after.xxmiRoot);if(normalize(check.gameDirectory)!==normalize(p.after.gameDirectory)||p.preview.scope==='sync-mods'&&!check.modsDirectories.some(d=>normalize(d)===normalize(p.after.modsDirectory)))throw new Error('修复后路径复检未通过。');}
   if(c.executable&&candidateEvidence!==await this.fileEvidence(c.executable))throw new Error('修复期间游戏 EXE 发生变化，请稍后重查。');
   for(const f of p.files)if(await optionalDigest(f.target)!==sha(f.after))throw new Error('修复期间外部配置被再次修改，保留现场。');
   if(!same((await this.store.read()).games[game],p.after))throw new Error('修复期间已保存游戏路径被改过，保留外部新值。');
   value.phase='complete';value.message='修复已提交并复检；不代表游戏或 Mod 已加载。';await writeAtomicJson(path.join(dir,'manifest.json'),JSON.stringify(value));
   // This cache is observational, never an authority for writes or compatibility.
   await writeAtomicJson(path.join(this.data,'environment-'+game+'.json'),JSON.stringify({version:1,gameDirectory:p.after.gameDirectory,xxmiRoot:p.after.xxmiRoot,observedAt:new Date().toISOString()})).catch(()=>{});this.reports.clear();
   return {gameId:game,repair:this.summary(owner,value),settings:await this.store.read(),warnings:p.preview.scope==='save'?['已保存路径；请重新检查是否仍需同步 Launcher。']:[]};
  }catch(error){if(created){try{await this.rollback(game,created.owner,created.files);created.value.phase='rolled-back';created.value.message='提交失败，已核对并回退。';}catch{created.value.phase='pending';created.value.message='回退遇到外部变化或占用，原文与副本保留；请预览回退。';}await writeAtomicJson(path.join(created.dir,'manifest.json'),JSON.stringify(created.value)).catch(()=>{});}throw new Error((error as Error).message+(created?' 修复记录和原字节副本已保留。':''));}finally{this.active=false;}
 }
}
