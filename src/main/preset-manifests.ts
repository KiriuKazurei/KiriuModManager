import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {GameId,Preset,ModEntry} from '../shared/contracts';
import type {PortablePreset,PresetManifestMember,PresetExportPreview,PresetImportPreview,ManifestChoice,ManifestMatch,PresetImportOptions,PresetImportReceipt} from '../shared/preset-workflows';
import {ModService,safeName} from './mods';
import {BusinessService} from './business';
import {SettingsStore} from './settings';
import {hashModTree,inspectModTree,ContentBudget} from './content-fingerprint';
import {readPresetPackage,readPortablePreset,encodePresetPackage,validateProfileBlobs,PRESET_LIMITS} from './preset-package';
import {assertNoLinks,containedPath} from './archive';
import {fileBytes,isInside,sha} from './inspection-files';
import {writeAtomicFile} from './atomic-json';

type Payload={manifest:PortablePreset;blobs:Map<string,Buffer>};
type Session=Payload&{id:string;game:GameId;root:string;expires:number;source?:{file:string;evidence:string};draftId?:string;draftEvidence?:string};
type Evidence={base:string;trees:Record<string,string>};
type ExportPlan=Payload&{preview:PresetExportPreview;game:GameId;expires:number;evidence:Evidence};
type ImportPlan={preview:PresetImportPreview;sessionId:string;expires:number;evidence:Evidence};
const lifetime=120000;
export class PresetManifests {
 private exports=new Map<string,ExportPlan>();private sessions=new Map<string,Session>();private imports=new Map<string,ImportPlan>();
 constructor(private directory:string,private mods:ModService,private business:BusinessService,private settings:SettingsStore){}
 private prune(){for(const map of [this.exports,this.sessions,this.imports]){for(const [id,item]of map)if(item.expires<Date.now())map.delete(id);while(map.size>20)map.delete(map.keys().next().value!);}}
 private assertMemory(bytes:number){const retained=[...this.exports.values(),...this.sessions.values()].reduce((total,payload)=>total+[...payload.blobs.values()].reduce((sum,b)=>sum+b.length,0),0);if(retained+bytes>128*1024**2)throw new Error('配置预览缓存超过 128 MiB，请关闭其它导入／导出后重试。');}
 private async base(game:GameId){return sha(JSON.stringify({paths:(await this.settings.read()).games[game],library:await this.mods.readonlyScan(game),data:(await this.mods.readonlyContext(game)).data,presets:await this.business.presets(game)}));}
 private async source(file:string){const stat=await fs.stat(file);return sha(JSON.stringify([stat.dev,stat.ino,stat.size,stat.mtimeMs,sha(await fileBytes(file,PRESET_LIMITS.zip))]));}
 private async verify(game:GameId,evidence:Evidence){if(evidence.base!==await this.base(game))throw new Error('库、预设或设置已改变，请重新读取清单。');const {data}=await this.mods.readonlyContext(game);for(const [id,expected]of Object.entries(evidence.trees)){const record=data.records[id];if(!record||record.deleted)throw new Error('匹配成员已移除，请重新读取。');if((await inspectModTree(containedPath(data.root,record.relativePath))).evidence!==expected)throw new Error('Mod 内容在预览后发生变化，请重新匹配。');}}
 async prepareExport(game:GameId,id:string,includeProfile:boolean,signal:AbortSignal,progress:(message:string)=>void):Promise<PresetExportPreview>{
  if(typeof includeProfile!=='boolean')throw new Error('导出选项无效。');this.prune();const before=await this.base(game),preset=(await this.business.presets(game)).find(p=>p.id===id);if(!preset)throw new Error('预设不存在。');
  const library=await this.mods.readonlyScan(game,signal),members:PresetManifestMember[]=[],trees:Record<string,string>={},budget:ContentBudget={remaining:8*1024**3};
  for(const [modId,enabled]of Object.entries(preset.members)){
   signal.throwIfAborted();const mod=library.mods.find(item=>item.id===modId);if(!mod)throw new Error('缺少成员 '+modId+'，无法读取内容哈希。');progress('计算内容哈希：'+mod.name);
   const hashed=await hashModTree(containedPath(library.root,mod.relativePath),budget,signal);trees[modId]=hashed.evidence;
   const source=mod.remote?{provider:'gamebanana' as const,modId:mod.remote.modId,fileId:mod.remote.fileId,entryPath:(mod.remote.entryPath||'').replace(/\\/g,'/'),downloadUrl:'https://gamebanana.com/dl/'+mod.remote.fileId,sourceUrl:'https://gamebanana.com/mods/'+mod.remote.modId}:undefined;
   members.push({key:'m'+members.length,id:mod.id,name:mod.name,enabled,version:mod.provenance.version,hash:hashed.hash,...(source?{source}:{})});
  }
  for(const member of preset.missingMods||[])members.push({...structuredClone(member),key:'m'+members.length});
  const manifest:PortablePreset={format:'kmm-preset',schemaVersion:1,gameId:game,name:preset.name,members},blobs=new Map<string,Buffer>();
  if(includeProfile){
   if(preset.missingMods?.length)throw new Error('清单仍缺少成员，请先补齐或仅导出启停清单。');const captured=await this.business.profiles.exportCaptured(game,id),compatible:Record<string,string>={};
   const files=captured.map(file=>{const member=members.find(item=>item.id===file.modId);if(!member)throw new Error('配置成员不属于导出清单。');blobs.set(file.sha256,file.bytes);return {key:member.key,relativePath:file.relativePath.replace(/\\/g,'/'),sha256:file.sha256};});
   for(const member of members.filter(member=>files.some(file=>file.key===member.key))){progress('检查配置资源兼容范围：'+member.name);const overrides=new Map(files.filter(file=>file.key===member.key).map(file=>[file.relativePath,blobs.get(file.sha256)!]));const mod=library.mods.find(item=>item.id===member.id)!;compatible[member.key]=(await hashModTree(containedPath(library.root,mod.relativePath),budget,signal,overrides)).hash.sha256;}
   manifest.profile={files,compatible};
  }
  readPortablePreset(manifest);validateProfileBlobs(manifest,blobs);if(Buffer.byteLength(JSON.stringify(manifest))>PRESET_LIMITS.json)throw new Error('清单超过 4 MiB。');
  const evidence={base:before,trees};await this.verify(game,evidence);signal.throwIfAborted();this.assertMemory([...blobs.values()].reduce((sum,b)=>sum+b.length,0));
  const expires=Date.now()+lifetime,preview:PresetExportPreview={kind:'preset-export',token:randomUUID(),name:preset.name,manifest,iniFiles:manifest.profile?.files.length||0,iniBytes:[...blobs.values()].reduce((sum,b)=>sum+b.length,0),expiresAt:new Date(expires).toISOString()};
  this.exports.set(preview.token,{manifest,blobs,preview,game,expires,evidence});return structuredClone(preview);
 }
 readExport(game:GameId,token:string){this.prune();const plan=this.exports.get(token);if(!plan||plan.game!==game||plan.expires<Date.now())throw new Error('清单导出预览已过期。');return plan;}
 async export(game:GameId,token:string,target:string){
  const plan=this.readExport(game,token);await this.verify(game,plan.evidence);const settings=await this.settings.read(),forbidden=[this.directory,...Object.values(settings.games).flatMap(paths=>Object.values(paths)).filter(Boolean)];
  if(!path.isAbsolute(target)||forbidden.some(root=>isInside(root,target))||!(plan.manifest.profile?/\.zip$/i:/\.json$/i).test(target))throw new Error('清单须保存到数据、游戏、Mod 和加载器目录之外，并使用对应 JSON／ZIP 扩展名。');
  await assertNoLinks(target);const targetIdentity=async()=>{try{const stat=await fs.lstat(target);if(!stat.isFile())throw new Error('导出目标不是普通文件。');return [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error;}};
  const expected=await targetIdentity(),temporary=path.join(path.dirname(target),'.kmm-preset-'+randomUUID()+'.tmp');
  try{await writeAtomicFile(temporary,encodePresetPackage(plan.manifest,plan.blobs),'missing');await this.verify(game,plan.evidence);await assertNoLinks(target);if(expected!==await targetIdentity())throw new Error('导出目标在准备期间被修改，原文件保持。');await fs.rename(temporary,target);this.exports.delete(token);return target;}finally{await fs.unlink(temporary).catch(()=>{});await fs.unlink(temporary+'.tmp').catch(()=>{});}
 }
 async prepareImport(game:GameId,file:string|undefined,draftId:string|undefined,signal:AbortSignal,progress:(message:string)=>void){
  this.prune();let payload:Payload,source:Session['source'];
  if(draftId){const preview=await this.prepareExport(game,draftId,false,signal,progress);payload={manifest:preview.manifest,blobs:new Map()};this.exports.delete(preview.token);if(!(await this.business.presets(game)).find(p=>p.id===draftId)?.missingMods?.length)throw new Error('该预设没有待补齐成员。');}
  else{if(!file)throw new Error('请选择预设清单。');source={file,evidence:await this.source(file)};payload=await readPresetPackage(file,signal);if(source.evidence!==await this.source(file))throw new Error('清单文件在读取期间改变。');}
  if(payload.manifest.gameId!==game)throw new Error('清单所属游戏与当前游戏不同。');validateProfileBlobs(payload.manifest,payload.blobs);this.assertMemory([...payload.blobs.values()].reduce((sum,b)=>sum+b.length,0));
  const session:Session={...payload,id:randomUUID(),game,root:(await this.settings.read()).games[game].modsDirectory,expires:Date.now()+600000,source,draftId,...(draftId?{draftEvidence:sha(JSON.stringify((await this.business.presets(game)).find(p=>p.id===draftId)))}:{})};this.sessions.set(session.id,session);
  try{return await this.revise(game,session.id,[],signal,progress);}catch(error){this.sessions.delete(session.id);throw error;}
 }
 async session(game:GameId,id:string){this.prune();const session=this.sessions.get(id);if(!session||session.game!==game||session.expires<Date.now())throw new Error('清单匹配任务已过期，请重新导入。');if(session.root!==(await this.settings.read()).games[game].modsDirectory)throw new Error('Mod 根目录已改变，请重新导入清单。');if(session.source&&session.source.evidence!==await this.source(session.source.file))throw new Error('原清单在读取后被修改，请重新导入。');if(session.draftId&&session.draftEvidence!==sha(JSON.stringify((await this.business.presets(game)).find(p=>p.id===session.draftId))))throw new Error('待匹配预设已改变，请重新读取。');return session;}
 async revise(game:GameId,id:string,choices:ManifestChoice[],signal:AbortSignal,progress:(message:string)=>void):Promise<PresetImportPreview>{
  const session=await this.session(game,id),before=await this.base(game),library=await this.mods.readonlyScan(game,signal),members=session.manifest.members;
  if(!Array.isArray(choices)||choices.length>5000||choices.some(choice=>!choice||!members.some(member=>member.key===choice.key)||choice.modId!==null&&typeof choice.modId!=='string'||typeof choice.acceptDifferentHash!=='boolean')||new Set(choices.map(choice=>choice.key)).size!==choices.length)throw new Error('清单匹配选择无效。');
  const candidates=library.mods.filter(mod=>!mod.id.startsWith('unindexed:'));
  const selected=new Map(choices.map(choice=>[choice.key,choice])),budget:ContentBudget={remaining:8*1024**3},trees:Record<string,string>={},hashes=new Map<string,Awaited<ReturnType<typeof hashModTree>>>(),summaries=new Map<string,Awaited<ReturnType<typeof inspectModTree>>>(),warnings:string[]=[],matches:ManifestMatch[]=[],used=new Set<string>();let inspected=0;
  const summary=async(mod:ModEntry)=>{if(!summaries.has(mod.id)){signal.throwIfAborted();const tree=await inspectModTree(containedPath(library.root,mod.relativePath),signal);inspected+=tree.files.length;if(inspected>200000)throw new Error('匹配盘点超出 200000 文件预算。');summaries.set(mod.id,tree);}return summaries.get(mod.id)!;};
  const hashErrors=new Map<string,Error>();
  const hashed=async(mod:ModEntry)=>{if(hashErrors.has(mod.id))throw hashErrors.get(mod.id)!;if(!hashes.has(mod.id)){try{progress('比较本地内容：'+mod.name);hashes.set(mod.id,await hashModTree(containedPath(library.root,mod.relativePath),budget,signal));}catch(error){hashErrors.set(mod.id,error as Error);throw error;}}return hashes.get(mod.id)!;};
  const byStructure=new Map<string,ModEntry[]>(),byHash=new Map<string,Map<string,ModEntry[]>>();let indexed=false;
  const exactMatches=async(member:PresetManifestMember)=>{
   if(!indexed){let count=0;for(const candidate of candidates){signal.throwIfAborted();try{const tree=await summary(candidate);const key=tree.structure;const bucket=byStructure.get(key)||[];bucket.push(candidate);byStructure.set(key,bucket);}catch(error){signal.throwIfAborted();if(warnings.length<20)warnings.push((error as Error).message);}if(++count%32===0)await new Promise<void>(resolve=>setImmediate(resolve));}indexed=true;}
   const key=member.hash.structure;if(!byHash.has(key)){const group=new Map<string,ModEntry[]>();let count=0;for(const candidate of byStructure.get(key)||[]){signal.throwIfAborted();try{const digest=(await hashed(candidate)).hash.sha256;const bucket=group.get(digest)||[];bucket.push(candidate);group.set(digest,bucket);}catch(error){signal.throwIfAborted();if(warnings.length<20)warnings.push((error as Error).message);}if(++count%32===0)await new Promise<void>(resolve=>setImmediate(resolve));}byHash.set(key,group);}return byHash.get(key)!.get(member.hash.sha256)||[];
  };
  for(const member of members){
   signal.throwIfAborted();let mod:ModEntry|undefined,basis:ManifestMatch['basis']='missing',hashMatches:boolean|null=null,message='缺少 Mod：'+member.name;
   const choice=selected.get(member.key);
   if(choice?.modId){mod=candidates.find(item=>item.id===choice.modId);if(!mod)throw new Error('所选替代 Mod 不属于当前库。');basis='manual';}
   else if(!choice){
    const site=member.source?candidates.filter(item=>item.remote?.modId===member.source!.modId&&item.remote?.fileId===member.source!.fileId&&(item.remote.entryPath||'').replace(/\\/g,'/')===member.source!.entryPath):[];
    if(site.length===1){mod=site[0];basis='site';}
    else{
     const exact=await exactMatches(member);
     if(exact.length===1){mod=exact[0];basis='hash';}else if(exact.length>1)message='存在多个相同哈希副本，请为 '+member.name+' 手动选择。';
    }
   }
   if(mod){
    if(used.has(mod.id)){if(choice)throw new Error('不同清单成员不能映射同一本地 Mod。');mod=undefined;basis='missing';message='匹配项已被另一成员使用，请手动选择：'+member.name;}
    else{try{const current=await hashed(mod);hashMatches=current.hash.sha256===member.hash.sha256;trees[mod.id]=current.evidence;}catch(error){signal.throwIfAborted();if(warnings.length<20)warnings.push((error as Error).message);trees[mod.id]=(await summary(mod)).evidence;}
     used.add(mod.id);message=hashMatches?'内容哈希一致':hashMatches===false?'内容哈希不同，需明确接受该替代':'未完成内容比较，需明确接受该替代';}
   }
   matches.push({member,modId:mod?.id||null,basis,hashMatches,accepted:!!mod&&(hashMatches===true||choice?.acceptDifferentHash===true),message});
  }
  let canImportProfile=!!session.manifest.profile&&matches.every(match=>match.accepted);
  if(canImportProfile)for(const [key,expected]of Object.entries(session.manifest.profile!.compatible)){
   const match=matches.find(item=>item.member.key===key)!;
   try{signal.throwIfAborted();const mod=library.mods.find(item=>item.id===match.modId!)!,overrides=new Map(session.manifest.profile!.files.filter(file=>file.key===key).map(file=>[file.relativePath,session.blobs.get(file.sha256)!]));if((await hashModTree(containedPath(library.root,mod.relativePath),budget,signal,overrides)).hash.sha256!==expected)throw new Error('资源内容不匹配');}
   catch(error){signal.throwIfAborted();canImportProfile=false;warnings.push(match.member.name+' 的独立 INI 无法确认兼容，可仅导入启停方案。');}
  }
  const evidence={base:before,trees};await this.verify(game,evidence);signal.throwIfAborted();
  const expires=Date.now()+lifetime,preview:PresetImportPreview={kind:'preset-import',token:randomUUID(),sessionId:session.id,gameId:game,name:session.manifest.name,matches,candidates:candidates.map(mod=>({id:mod.id,name:mod.name,relativePath:mod.relativePath})),warnings:[...new Set(warnings)].slice(0,20),missing:matches.filter(match=>!match.accepted).map(match=>match.member.name),canImportProfile,hasProfile:!!session.manifest.profile,expiresAt:new Date(expires).toISOString()};
  this.prune();this.imports.set(preview.token,{preview,sessionId:session.id,expires,evidence});return structuredClone(preview);
 }
 async commit(game:GameId,token:string,options:PresetImportOptions):Promise<PresetImportReceipt>{
  const plan=this.imports.get(token);if(!plan||plan.preview.gameId!==game||plan.expires<Date.now())throw new Error('清单确认已过期，请重新匹配。');
  if(!options||typeof options.allowMissing!=='boolean'||typeof options.includeProfile!=='boolean')throw new Error('清单导入选项无效。');const name=safeName(options.name),session=await this.session(game,plan.sessionId);await this.verify(game,plan.evidence);
  if(plan.preview.missing.length&&!options.allowMissing)throw new Error('缺少 Mod：'+plan.preview.missing.join('、'));
  if(options.includeProfile&&!plan.preview.canImportProfile)throw new Error('独立配置未全部匹配或资源不兼容，请仅导入启停方案。');
  const accepted=plan.preview.matches.filter(match=>match.accepted),members=Object.fromEntries(accepted.map(match=>[match.modId!,match.member.enabled])),missingMods=plan.preview.matches.filter(match=>!match.accepted).map(match=>match.member),id=session.draftId||randomUUID();
  let preset:Preset={id,name,members,mode:'states',updatedAt:new Date().toISOString(),...(missingMods.length?{missingMods}:{})},staged:Awaited<ReturnType<BusinessService['profiles']['stageCaptured']>>|undefined;
  try{
   if(options.includeProfile){const files=session.manifest.profile!.files.map(file=>({modId:accepted.find(match=>match.member.key===file.key)!.modId!,relativePath:file.relativePath,bytes:session.blobs.get(file.sha256)!}));staged=await this.business.profiles.stageCaptured(game,id,name,members,files);preset=staged.preset;}
   await this.verify(game,plan.evidence);this.imports.delete(token);await this.business.publishImportedPreset(game,preset,staged,session.draftId);
  }finally{if(staged)await this.business.profiles.discardStage(game,staged.stage).catch(()=>{});}
  return {presetId:id,name,matched:accepted.length,missing:missingMods.map(member=>member.name),replacements:accepted.filter(match=>match.hashMatches!==true).map(match=>({name:match.member.name,replacement:plan.preview.candidates.find(item=>item.id===match.modId)!.name})),profileImported:!!staged};
 }
}
