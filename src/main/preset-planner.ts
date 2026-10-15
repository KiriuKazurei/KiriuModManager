import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {GameId,Preset,ExclusiveChoices,DependencyConfirmation,PresetApplyResult} from '../shared/contracts';
import type {PresetApplyPreview,PresetCommitResult} from '../shared/preset-workflows';
import {ModService} from './mods';
import {SettingsStore} from './settings';
import {FileOperations} from './file-operations';
import {assertNoLinks,containedPath} from './archive';
import {exclusiveRequests} from './exclusive-groups';
import {dependencyOrder,installedVersions,DependencyError} from './dependencies';
import {sha} from './inspection-files';

export class PresetPlanner {
 private plans=new Map<string,{plan:PresetApplyPreview;choices:ExclusiveChoices;excluded:string[];requested:Record<string,boolean>;evidence:string;expires:number}>();
 constructor(private directory:string,private mods:ModService,private settings:SettingsStore,private list:(game:GameId)=>Promise<Preset[]>){ }
 private async evidence(game:GameId,id:string){
  const library=await this.mods.readonlyScan(game),paths=(await this.settings.read()).games[game],preset=(await this.list(game)).find(p=>p.id===id);
  const directories=[];
  for(const mod of library.mods){const target=containedPath(library.root,mod.relativePath);await assertNoLinks(target);const stat=await fs.lstat(target,{bigint:true});directories.push([mod.id,String(stat.dev),String(stat.ino),String(stat.mtimeNs)]);}
  const {data}=await this.mods.readonlyContext(game);
  return sha(JSON.stringify({library,paths,preset,data,directories,versions:await installedVersions(game,paths.xxmiRoot)}));
 }
 async prepare(game:GameId,id:string,choices:ExclusiveChoices={},excluded:string[]=[],signal?:AbortSignal):Promise<PresetApplyPreview>{
  signal?.throwIfAborted();const preset=(await this.list(game)).find(p=>p.id===id);if(!preset)throw new Error('预设不存在。');if(preset.mode==='profile')throw new Error('独立配置档请使用配置切换预览。');
  if(!Array.isArray(excluded)||excluded.length>5000||excluded.some(key=>typeof key!=='string')||new Set(excluded).size!==excluded.length)throw new Error('排除成员无效。');
  const before=await this.evidence(game,id),library=await this.mods.readonlyScan(game,signal),byId=new Map(library.mods.map(mod=>[mod.id,mod]));
  const missing=(preset.missingMods||[]).map(member=>({id:'missing:'+member.key,name:member.name}));
  const known=new Set([...Object.keys(preset.members),...missing.map(m=>m.id)]);
  if(excluded.some(key=>!known.has(key)))throw new Error('排除成员不属于当前预设。');
  const ids=Object.keys(preset.members).filter(key=>byId.has(key)&&!excluded.includes(key));
  const exclusive=exclusiveRequests(library.exclusiveGroups,ids.filter(key=>preset.members[key]),choices);
  const requested=Object.fromEntries(ids.map(key=>[key,exclusive.enabled.has(key)]));
  const dependency=await this.mods.previewStates(game,library,{states:requested});
  const blockers:string[]=[],rows:PresetApplyPreview['rows']=[];
  const registry=(await this.mods.readonlyContext(game)).data;
  for(const key of Object.keys(preset.members))if(!byId.has(key))missing.push({id:key,name:registry.records[key]?.relativePath?path.basename(registry.records[key].relativePath).replace(/^DISABLED_?/i,''):key});
  for(const member of missing){const skip=excluded.includes(member.id);rows.push({id:member.id,name:member.name,current:null,desired:null,outside:false,status:skip?'excluded':'missing',message:skip?'本次明确排除；原预设记录保留':'缺少 Mod：'+member.name});if(!skip)blockers.push('请补齐或明确排除缺少的 Mod：'+member.name+'（'+member.id+'）');}
  for(const key of excluded.filter(key=>byId.has(key))){const mod=byId.get(key)!;rows.push({id:key,name:mod.name,current:mod.enabled,desired:null,outside:false,status:'excluded',message:'本次排除直接请求；互斥或依赖联动仍会单独列出'});}
  for(const [key,enabled] of Object.entries(dependency.states)){
   const mod=byId.get(key);if(!mod)continue;
   const changes=enabled?!mod.enabled:!mod.ownDisabled;
   let message=Object.hasOwn(requested,key)?preset.members[key]&&!enabled?'按明确互斥选择保持停用':'预设成员请求':'预设外互斥／依赖联动';
   let status:PresetApplyPreview['rows'][number]['status']=changes?enabled?'enable':'disable':'unchanged';
   if(!enabled&&!mod.enabled&&!mod.ownDisabled)message+='；父目录已停用，仍将停用自身目录';
   if(enabled&&(mod.disabledAncestors.length||/^DISABLED/i.test(path.basename(library.root)))){status='blocked';blockers.push(mod.name+'：父分类目录或 Mod 根目录停用，不能启用。');}
   if(changes){
    const from=containedPath(library.root,mod.relativePath),target=path.join(path.dirname(from),enabled?path.basename(from).replace(/^DISABLED_?/i,''):'DISABLED_'+path.basename(from).replace(/^DISABLED_?/i,''));
    await assertNoLinks(target);
    try{await fs.lstat(target);if(from.toLowerCase()!==target.toLowerCase()){status='blocked';blockers.push(mod.name+'：目标已有同名目录，请先改名。');}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   }
   rows.push({id:key,name:mod.name,current:mod.enabled,desired:enabled,outside:!Object.hasOwn(requested,key),status,message});
  }
  for(const issue of dependency.issues)if(issue.severity==='block')blockers.push(issue.message);
  if(!ids.length)blockers.push('没有可应用的本地成员。');
  const changes=rows.filter(row=>row.status==='enable'||row.status==='disable').length;
  if(changes>5000)blockers.push('目录变化超过 5000 项。');
  await new FileOperations(this.directory).assertReady(game,library.root);
  signal?.throwIfAborted();if(before!==await this.evidence(game,id))throw new Error('预设或目录在读取期间发生变化，请重新预览。');
  const expires=Date.now()+120000;
  const plan:PresetApplyPreview={kind:'preset-preview',token:randomUUID(),gameId:game,presetId:id,name:preset.name,root:library.root,expiresAt:new Date(expires).toISOString(),rows,conflicts:exclusive.conflicts,dependency,blockers,canApply:!blockers.length&&!exclusive.conflicts.length,changes};
  for(const [key,item]of this.plans)if(item.expires<Date.now())this.plans.delete(key);
  if(this.plans.size>=20)this.plans.delete(this.plans.keys().next().value!);
  this.plans.set(plan.token,{plan,choices:{...choices},excluded:[...excluded],requested,evidence:before,expires});return structuredClone(plan);
 }
 read(game:GameId,token:string){const stored=this.plans.get(token);if(!stored||stored.plan.gameId!==game||stored.expires<Date.now())throw new Error('预设预览已过期，请重新预览。');return stored;}
 async validate(game:GameId,token:string){const stored=this.read(game,token);if(stored.evidence!==await this.evidence(game,stored.plan.presetId))throw new Error('预设、目录、成员或版本在预览后发生变化，请重新预览。');return stored;}
 async commit(game:GameId,token:string,confirmation?:DependencyConfirmation):Promise<PresetCommitResult>{
  const stored=await this.validate(game,token);if(!stored.plan.canApply)throw new Error('请先处理预设预览中的缺失、互斥选择与阻挡。');
  const library=await this.mods.readonlyScan(game);
  const checked=await this.mods.checkedStates(game,library,{states:stored.requested},confirmation);
  if(JSON.stringify(checked.states)!==JSON.stringify(stored.plan.dependency.states))throw new Error('最终启停状态已改变，请重新预览。');
  const expected=sha(await fs.readFile(path.join(this.directory,'library-'+game+'.json'))),{data}=await this.mods.context(game),moves:Parameters<FileOperations['runPreset']>[3]=[];
  for(const key of dependencyOrder(library,checked.states)){
   const row=stored.plan.rows.find(item=>item.id===key&&['enable','disable'].includes(item.status));if(!row)continue;
   const mod=library.mods.find(item=>item.id===key)!,from=containedPath(data.root,mod.relativePath),base=path.basename(from).replace(/^DISABLED_?/i,''),target=path.join(path.dirname(from),checked.states[key]?base:'DISABLED_'+base);
   data.records[key].relativePath=path.relative(data.root,target);moves.push({kind:'move',from,target});
  }
  await this.validate(game,token);this.plans.delete(token);
  if(moves.length)await new FileOperations(this.directory).runPreset(game,data.root,'应用预设 '+stored.plan.name,moves,[{target:path.join(this.directory,'library-'+game+'.json'),bytes:JSON.stringify(data,null,2),expected}]);
  return {library:await this.mods.scan(game),applied:moves.length,unchanged:stored.plan.rows.filter(row=>row.status==='unchanged').length,excluded:[...stored.excluded]};
 }
 async legacy(game:GameId,id:string,choices?:ExclusiveChoices,confirmation?:DependencyConfirmation):Promise<PresetApplyResult>{
  const plan=await this.prepare(game,id,choices);if(plan.dependency.issues.some(issue=>issue.severity==='block'))throw new DependencyError(plan.dependency);if(!plan.canApply)return {library:await this.mods.scan(game),applied:0,conflicts:plan.conflicts,issues:plan.blockers};
  const result=await this.commit(game,plan.token,confirmation);return {...result,applied:result.applied+result.unchanged,conflicts:[],issues:[]};
 }
}
