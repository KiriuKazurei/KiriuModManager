import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {GameId} from '../shared/contracts';
import type {ConflictOccurrence,ConflictInspection,ConflictDetails} from '../shared/inspections';
import {ModService} from './mods';
import {decodeIni} from './ini';
import {assertNoLinks,containedPath} from './archive';
import {fileBytes,sha,INSPECTION_LIMITS,isInside} from './inspection-files';
type ContextOccurrence=Omit<ConflictOccurrence,'modId'|'modName'|'contentRevision'|'fileRelativePath'|'rootRelativePath'|'digest'>;
export function parseIniContext(text:string):ContextOccurrence[]{
 const namespaces:string[]=[],sections:{name:string;lines:{text:string;line:number}[]}[]=[];let current:typeof sections[number]|undefined;
 for(const [index,raw]of text.split(/\r\n|\n|\r/).entries()){const line=raw.trim();if(!line||/^[;#]/.test(line))continue;const heading=/^\[([^\]]+)\]/.exec(line);if(heading){current={name:heading[1],lines:[]};sections.push(current);continue;}const namespace=/^namespace\s*=\s*(.*?)(?:\s*;.*)?$/i.exec(line);if(namespace)namespaces.push(namespace[1].slice(0,500));if(current)current.lines.push({text:line,line:index+1});}
 const occurrences:ContextOccurrence[]=[];
 for(const section of sections){const type=/^TextureOverride/i.test(section.name)?'texture':/^ShaderOverride/i.test(section.name)?'shader':null;if(!type)continue;
  const conditions:string[]=[],filters:string[]=[],resources:string[]=[],runs:string[]=[],warnings:string[]=[];const fields=new Map<string,number>();
  for(const item of section.lines){const match=/^([^=]+?)\s*=\s*(.*?)(?:\s*;.*)?$/.exec(item.text);if(/^(if\b|else\b|elif\b|endif\b)/i.test(item.text))conditions.push(`行 ${item.line}: ${item.text.slice(0,500)}`);if(!match)continue;const key=match[1].trim().toLowerCase(),value=match[2].slice(0,500);fields.set(key,(fields.get(key)||0)+1);if(key==='condition')conditions.push(`行 ${item.line}: ${value}`);if(/^match_|^filter_index$/.test(key))filters.push(`行 ${item.line}: ${key} = ${value}`);if(key==='run')runs.push(`行 ${item.line}: ${value}`);if(/^(?:[pvhdgc]s-t\d+|vb\d+|ib|this|Resource\S*)$/i.test(key))resources.push(`行 ${item.line}: ${key} = ${value}`);}
  if([...fields.values()].some(count=>count>1))warnings.push('包含重复字段；保留各处定义，未推断覆盖优先级。');if(conditions.length)warnings.push('条件仅展示原文，不执行表达式。');if(runs.length)warnings.push('run 引用未递归展开；跨文件与命名空间解析未知。');if(resources.length)warnings.push('资源引用仅为静态线索，不能证明渲染相同或冲突。');
  for(const item of section.lines){const hash=/^hash\s*=\s*(?:0x)?([\da-f]{8}|[\da-f]{16})\s*(?:;.*|\/\/.*)?$/i.exec(item.text);if(hash)occurrences.push({line:item.line,section:section.name,type,hash:hash[1].toLowerCase(),namespace:namespaces.slice(0,30),conditions:conditions.slice(0,100),filters:filters.slice(0,100),resources:resources.slice(0,100),runs:runs.slice(0,100),warnings:[...warnings,...(namespaces.length>1?['存在多个 namespace 声明；语义未知。']:[])]});if(occurrences.length>=50000)return occurrences;}
 }
 return occurrences;
}
export async function localResourceEvidence(text:string,file:string,modRoot:string,references:string[]){
 const definitions=new Map<string,string[]>();let section='';for(const raw of text.split(/\r\n|\r|\n/)){const heading=/^\s*\[([^\]]+)\]/.exec(raw);if(heading){section=heading[1];continue;}const field=/^\s*filename\s*=\s*(.*?)(?:\s*;.*)?$/i.exec(raw);if(/^resource/i.test(section)&&field){const values=definitions.get(section.toLowerCase())||[];values.push(field[1]);definitions.set(section.toLowerCase(),values);}}
 const result:string[]=[];for(const reference of references.slice(0,50)){const name=/=\s*(Resource[^\s]+)\s*$/i.exec(reference)?.[1],files=name?definitions.get(name.toLowerCase()):undefined;if(!files||files.length!==1){result.push(reference+' · 本文件资源定义未解析／歧义');continue;}const relative=files[0].replace(/^"(.*)"$/,'$1');if(/[\0:$\{\}]/.test(relative)||path.isAbsolute(relative)){result.push(reference+' · 路径表达式未知，未读取');continue;}const target=path.resolve(path.dirname(file),relative.replace(/[\\/]/g,path.sep));if(!isInside(modRoot,target)){result.push(reference+' · 路径越出 Mod，未读取');continue;}try{await assertNoLinks(target);const stat=await fs.stat(target);result.push(reference+' · 静态相对文件'+(stat.isFile()?'存在':'不是普通文件')+'：'+path.relative(modRoot,target));}catch{result.push(reference+' · 静态相对文件缺失／不可读／含链接');}}
 return result;
}
export class ConflictInspector {
 private results=new Map<string,{report:ConflictInspection;root:string;occurrences:ConflictOccurrence[];expires:number}>();
 constructor(private mods:ModService){}
 async scan(game:GameId,signal:AbortSignal,progress:(message:string)=>void):Promise<ConflictInspection>{
  const library=await this.mods.readonlyScan(game,signal);const warnings:string[]=[],occurrences:ConflictOccurrence[]=[];let files=0,bytes=0,complete=true;
  for(const mod of library.mods.filter(m=>m.enabled)){signal.throwIfAborted();if(mod.id.startsWith('unindexed:')){complete=false;warnings.push('有尚未建立稳定身份的 Mod，请先在 Mod 库扫描后重新检查。');continue;}const root=containedPath(library.root,mod.relativePath);const queue:{folder:string;depth:number}[]=[{folder:root,depth:0}];
   while(queue.length){signal.throwIfAborted();const {folder,depth}=queue.shift()!;if(depth>16){complete=false;warnings.push('INI 目录深度超出预算。');continue;}try{await assertNoLinks(folder);for(const entry of await fs.readdir(folder,{withFileTypes:true})){if(entry.isSymbolicLink()){complete=false;warnings.push('跳过目录链接。');continue;}if(/^DISABLED/i.test(entry.name))continue;const file=path.join(folder,entry.name);if(entry.isDirectory())queue.push({folder:file,depth:depth+1});else if(entry.isFile()&&/\.ini$/i.test(entry.name)&&!/^desktop\.ini$/i.test(entry.name)){
     if(++files>INSPECTION_LIMITS.iniFiles){complete=false;warnings.push('INI 文件数量达到扫描上限。');queue.length=0;break;}signal.throwIfAborted();progress(`读取 INI ${files}`);try{const raw=await fileBytes(file,INSPECTION_LIMITS.iniBytes);bytes+=raw.length;if(bytes>INSPECTION_LIMITS.iniTotal){complete=false;warnings.push('INI 总读取量达到上限。');queue.length=0;break;}const decoded=decodeIni(raw),fileRelativePath=path.relative(root,file);const parsed=parseIniContext(decoded.text);
      for(const occurrence of parsed){occurrences.push({...occurrence,modId:mod.id,modName:mod.name,contentRevision:mod.contentRevision||'',fileRelativePath,rootRelativePath:path.relative(library.root,file),digest:sha(raw)});if(occurrences.length>=50000){complete=false;warnings.push('hash 出现位置达到上限。');break;}}
     }catch{complete=false;warnings.push('部分 INI 无法读取、编码不支持或超过 4 MiB。');}
    }}
   }catch{complete=false;warnings.push('部分目录无法完整读取。');}if(bytes>INSPECTION_LIMITS.iniTotal||files>INSPECTION_LIMITS.iniFiles||occurrences.length>=50000)break;
   }if(bytes>INSPECTION_LIMITS.iniTotal||files>INSPECTION_LIMITS.iniFiles||occurrences.length>=50000)break;
  }
  const allHash=new Map<string,Set<string>>(),groups=new Map<string,ConflictOccurrence[]>();for(const item of occurrences){const mods=allHash.get(item.hash)||new Set<string>();mods.add(item.modId);allHash.set(item.hash,mods);const key=item.type+':'+item.hash;const group=groups.get(key)||[];group.push(item);groups.set(key,group);}
  const selected=[...groups].filter(([,items])=>allHash.get(items[0].hash)!.size>1);if(selected.length>INSPECTION_LIMITS.groups){complete=false;warnings.push('候选组超过 2000，结果已截断。');}const resultId=randomUUID();const report:ConflictInspection={kind:'conflicts',gameId:game,resultId,groups:selected.slice(0,INSPECTION_LIMITS.groups).map(([id,items])=>({id,type:items[0].type,hash:items[0].hash,modIds:[...new Set(items.map(i=>i.modId))],occurrenceCount:items.length})),warnings:[...new Set(warnings)],scannedMods:library.mods.filter(m=>m.enabled).length,scannedFiles:Math.min(files,INSPECTION_LIMITS.iniFiles),complete};
  for(const [key,result]of this.results)if(result.expires<Date.now())this.results.delete(key);if(this.results.size>=20)this.results.delete(this.results.keys().next().value!);this.results.set(resultId,{report,root:library.root,occurrences,expires:Date.now()+600000});return report;
 }
 async details(game:GameId,resultId:string,groupId:string,offset=0):Promise<ConflictDetails>{
  const result=this.results.get(resultId),group=result?.report.groups.find(g=>g.id===groupId);if(!result||result.expires<Date.now()||result.report.gameId!==game||!group)throw new Error('候选结果已过期，请重新检查。');if(!Number.isSafeInteger(offset)||offset<0||offset>50000)throw new Error('位置分页无效。');const context=await this.mods.readonlyContext(game);if(context.data.root.toLowerCase()!==result.root.toLowerCase())throw new Error('游戏根目录已改变，请重新检查。');const all=result.occurrences.filter(item=>item.hash===group.hash);const occurrences:ConflictDetails['occurrences']=[];let snippetBytes=0;
  for(const item of all.slice(offset,offset+30)){const mod=await this.mods.readonlyContext(game,item.modId);if(mod.record!.contentRevision!==item.contentRevision)throw new Error('Mod 已移动或替换，请重新检查。');if(path.join(mod.record!.relativePath,item.fileRelativePath)!==item.rootRelativePath||mod.record!.relativePath.split(path.sep).some(p=>/^DISABLED/i.test(p))||/^DISABLED/i.test(path.basename(result.root))||item.fileRelativePath.split(path.sep).some(p=>/^DISABLED/i.test(p)))throw new Error('Mod 路径或启停状态已改变，请重新检查。');const file=containedPath(mod.directory,item.fileRelativePath);const raw=await fileBytes(file,INSPECTION_LIMITS.iniBytes);if(sha(raw)!==item.digest)throw new Error('INI 在扫描后已改变，请重新检查。');const text=decodeIni(raw).text,lines=text.split(/\r\n|\n|\r/),start=Math.max(0,item.line-11);let snippet=lines.slice(start,item.line+10).map((line,i)=>`${start+i+1}: ${line}`).join('\n');const available=Math.max(0,64*1024-snippetBytes);if(Buffer.byteLength(snippet)>available)snippet=Buffer.from(snippet).subarray(0,available).toString('utf8')+'\n[片段已截断]';snippetBytes+=Buffer.byteLength(snippet);occurrences.push({...item,resources:await localResourceEvidence(text,file,mod.directory,item.resources),snippet});}
  const warnings=['静态 hash 重叠是候选线索，不代表运行时渲染错误。命名空间、条件与资源差异不能直接证明冲突或无冲突。'];if(all.some(i=>i.type!==group.type))warnings.push('同一 hash 还出现在另一种 override 类型；已保留上下文，未合并类型语义。');return {group,occurrences,total:all.length,offset,warnings};
 }
}
