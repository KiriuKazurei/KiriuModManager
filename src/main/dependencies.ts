import {inspectInstalledVersions} from './installed-versions';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {GAMES} from '../shared/contracts';
import type {GameId,LibrarySnapshot,DependencyRequest,DependencyPlan,DependencyConfirmation,ModRequirements} from '../shared/contracts';
import {compareVersions,readRequirements} from '../shared/mod-library';
import {assertNoLinks} from './archive';

export class DependencyError extends Error {readonly code='DEPENDENCY_CONFIRMATION';constructor(readonly details:DependencyPlan){super(details.issues.map(x=>x.message).join('\n'));}}
export async function installedVersions(game:GameId,root:string):Promise<DependencyPlan['versions']>{const values=await inspectInstalledVersions(game,root);return {launcher:values.launcher.version,xxmi:values.xxmi.version,importer:values.importer.version};}
export function validateDependencyGraph(library:LibrarySnapshot,id:string,value:ModRequirements){
 for(const dep of value.mods)if(!library.mods.some(m=>m.id===dep.modId)&&!library.mods.find(m=>m.id===id)?.requirements?.mods.some(d=>d.modId===dep.modId))throw new Error('新增依赖须选择当前游戏、当前目录中的 Mod。');
 const requirements=readRequirements(value);const declarations=new Map(library.mods.map(m=>[m.id,m.id===id?requirements:m.requirements]));const visiting=new Set<string>(),done=new Set<string>();
 const visit=(key:string)=>{if(visiting.has(key))throw new Error('依赖包含自身或循环引用，未保存。');if(done.has(key))return;visiting.add(key);for(const dep of declarations.get(key)?.mods||[])visit(dep.modId);visiting.delete(key);done.add(key);};for(const key of declarations.keys())visit(key);
}
export class Dependencies {
 private plans=new Map<string,{fingerprint:string;expires:number;plan:DependencyPlan}>();
 plan(library:LibrarySnapshot,versions:DependencyPlan['versions'],request:DependencyRequest):DependencyPlan {
  const states={...request.states};if(request.deleteId)states[request.deleteId]=false;
  if(Object.keys(states).length>5000||Object.entries(states).some(([id,value])=>!library.mods.some(m=>m.id===id)||typeof value!=='boolean'))throw new Error('依赖检查成员不存在或状态无效。');
  const projected=new Map(library.mods.map(m=>[m.id,states[m.id]??m.enabled]));const dependents=new Set<string>();let changed=true;
  while(changed){changed=false;for(const mod of library.mods)if(projected.get(mod.id)&&states[mod.id]!==true&&(mod.requirements?.mods||[]).some(dep=>states[dep.modId]===false)){states[mod.id]=false;projected.set(mod.id,false);dependents.add(mod.id);changed=true;}}
  const issues:DependencyPlan['issues']=[];
  if(dependents.size)issues.push({modId:[...dependents][0],severity:'warning',message:'此操作需要同时停用依赖它的 Mod：'+library.mods.filter(m=>dependents.has(m.id)).map(m=>m.name).join('、')});
  for(const mod of library.mods)if(projected.get(mod.id)){
   const req=mod.requirements;if(!req)continue;
   for(const dep of req.mods){const provider=library.mods.find(m=>m.id===dep.modId);if(!provider||!projected.get(dep.modId)){issues.push({modId:mod.id,severity:'block',message:`${mod.name}：依赖 ${provider?.name||dep.modId} 缺失或停用。`});continue;}if(dep.minimumVersion){const cmp=compareVersions(provider.provenance.version,dep.minimumVersion);if(cmp===null)issues.push({modId:mod.id,severity:'warning',message:`${mod.name}：无法比较 ${provider.name} 的版本与要求 ${dep.minimumVersion}。`});else if(cmp<0)issues.push({modId:mod.id,severity:'block',message:`${mod.name}：${provider.name} 版本低于 ${dep.minimumVersion}。`});}}
   for(const dep of req.components){const installed=versions[dep.component];const cmp=installed?compareVersions(installed,dep.minimumVersion):null;issues.push(...(cmp===null?[{modId:mod.id,severity:'warning' as const,message:`${mod.name}：${dep.component} 安装版本未知，要求 ${dep.minimumVersion}。`}]:cmp<0?[{modId:mod.id,severity:'block' as const,message:`${mod.name}：${dep.component} 版本 ${installed} 低于 ${dep.minimumVersion}。`}]:[]));}
   if(req.gameVersion)issues.push({modId:mod.id,severity:'warning',message:`${mod.name}：声明适用游戏版本 ${req.gameVersion}，请自行核对当前游戏。`});
  }
  const plan={token:randomUUID(),states,issues,dependents:[...dependents],versions};const fingerprint=this.fingerprint(library,versions,request);this.plans.set(plan.token,{plan,fingerprint,expires:Date.now()+120000});for(const [key,item]of this.plans)if(item.expires<Date.now())this.plans.delete(key);return plan;
 }
 private fingerprint(library:LibrarySnapshot,versions:DependencyPlan['versions'],request:DependencyRequest){return createHash('sha256').update(JSON.stringify({root:library.root,game:library.gameId,mods:library.mods.map(m=>[m.id,m.relativePath,m.enabled,m.contentRevision,m.provenance.version,m.requirements]),groups:library.exclusiveGroups,versions,request})).digest('hex');}
 check(library:LibrarySnapshot,versions:DependencyPlan['versions'],request:DependencyRequest,confirmation?:DependencyConfirmation){
  let plan:DependencyPlan;
  if(confirmation){const item=this.plans.get(confirmation.token);if(!item||item.expires<Date.now()||item.fingerprint!==this.fingerprint(library,versions,request))throw new Error('依赖确认已过期或目录/成员发生变化，请重新检查。');plan=item.plan;this.plans.delete(confirmation.token);}else plan=this.plan(library,versions,request);
  if(plan.issues.some(x=>x.severity==='block')||plan.issues.length&&!confirmation?.acceptWarnings)throw new DependencyError(plan);return plan;
 }
}
export function dependencyOrder(library:LibrarySnapshot,states:Record<string,boolean>):string[]{
 const result:string[]=[];const done=new Set<string>(),visiting=new Set<string>();const visit=(id:string)=>{if(done.has(id))return;if(visiting.has(id))throw new Error('依赖声明存在循环。');visiting.add(id);for(const dep of library.mods.find(m=>m.id===id)?.requirements?.mods||[])if(Object.hasOwn(states,dep.modId))visit(dep.modId);visiting.delete(id);done.add(id);result.push(id);};for(const id of Object.keys(states))visit(id);
 return [...result.filter(id=>!states[id]).reverse(),...result.filter(id=>states[id])];
}
