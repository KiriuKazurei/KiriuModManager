import {promises as fs} from 'node:fs';
import path from 'node:path';
import * as yauzl from 'yauzl';
import {Zip,ZipPassThrough} from 'fflate';
import type {PortablePreset,PresetManifestMember,ModTreeHash} from '../shared/preset-workflows';
import {GAMES} from '../shared/contracts';
import {assertNoLinks} from './archive';
import {safeName} from './mods';
import {sha} from './inspection-files';
import {validateWebUrl} from './web-links';

export const PRESET_LIMITS={json:4*1024**2,ini:4*1024**2,iniTotal:64*1024**2,zip:80*1024**2,output:68*1024**2};
const text=(value:unknown,max:number)=>{if(typeof value!=='string'||value.length>max||/[\x00-\x1f]/.test(value))throw new Error('清单文字字段无效。');return value;};
const hex=(value:unknown)=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error('清单 SHA256 无效。');return value;};
const number=(value:unknown)=>{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('清单数量无效。');return value;};
export function portableIniPath(value:unknown){const name=text(value,1024).replace(/\\/g,'/');if(!name||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'||/[<>:"|?*]/.test(part)||/[. ]$/.test(part))||!/\.ini$/i.test(name)||/^desktop\.ini$/i.test(name.split('/').at(-1)!))throw new Error('配置清单包含不安全的 INI 路径。');return name;}
export function parseUniqueJson(input:Buffer){
 if(input.length>PRESET_LIMITS.json)throw new Error('预设清单超过 4 MiB。');const source=input.toString('utf8').replace(/^\uFEFF/,'');const value=JSON.parse(source);
 const stack:(Set<string>|null)[]=[];let count=0;
 for(const match of source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]]/g)){
  if(++count>200000)throw new Error('清单结构过大。');const token=match[0];
  if(token==='{')stack.push(new Set());else if(token==='[')stack.push(null);else if(token==='}'||token===']')stack.pop();
  else if(source.slice(match.index!+token.length).match(/^\s*:/)){const key=JSON.parse(token),keys=stack.at(-1);if(!keys||keys.has(key))throw new Error('清单包含重复对象 key。');keys.add(key);}
  if(stack.length>32)throw new Error('清单嵌套过深。');
 }
 return value;
}
export function readManifestMember(value:any):PresetManifestMember{
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.enabled!=='boolean')throw new Error('清单成员无效。');
 const h=value.hash;if(!h||h.algorithm!=='mod-tree-v1')throw new Error('本地 Mod 需要 mod-tree-v1 内容哈希。');
 const hash:ModTreeHash={algorithm:'mod-tree-v1',sha256:hex(h.sha256),files:number(h.files),bytes:number(h.bytes),structure:hex(h.structure)};
 if(hash.files>50000||hash.bytes>8*1024**3)throw new Error('清单 Mod 超出比较预算。');
 let source:PresetManifestMember['source'];
 if(value.source!==undefined){const s=value.source;if(!s||s.provider!=='gamebanana'||!number(s.modId)||!number(s.fileId))throw new Error('清单网站身份无效。');const entryPath=text(s.entryPath,1024).replace(/\\/g,'/');if(entryPath&&(entryPath.startsWith('/')||entryPath.split('/').some((p:string)=>!p||p==='.'||p==='..'||p.includes(':'))))throw new Error('清单站点条目路径无效。');source={provider:'gamebanana',modId:s.modId,fileId:s.fileId,entryPath,downloadUrl:validateWebUrl(s.downloadUrl),sourceUrl:validateWebUrl(s.sourceUrl)};if(!source.downloadUrl)throw new Error('网站 Mod 缺少下载链接。');}
 return {key:text(value.key,200),id:text(value.id,200),name:safeName(value.name),enabled:value.enabled,version:text(value.version,200),hash,...(source?{source}:{})};
}
export function readPortablePreset(value:any):PortablePreset{
 if(!value||value.format!=='kmm-preset'||value.schemaVersion!==1||typeof value.gameId!=='string'||!Object.hasOwn(GAMES,value.gameId)||!Array.isArray(value.members)||!value.members.length||value.members.length>5000)throw new Error('预设清单格式、游戏或版本无效。');
 const members=value.members.map(readManifestMember),keys=new Set(members.map((m:PresetManifestMember)=>m.key));if(keys.size!==members.length||members.some((m:PresetManifestMember)=>!m.key))throw new Error('清单成员 key 重复或为空。');
 let profile:PortablePreset['profile'];
 if(value.profile!==undefined){const p=value.profile;if(!p||!Array.isArray(p.files)||p.files.length>2048||!p.files.length||!p.compatible||typeof p.compatible!=='object'||Array.isArray(p.compatible))throw new Error('独立配置清单无效。');const seen=new Set<string>();const files=p.files.map((f:any)=>{if(!f||!keys.has(f.key))throw new Error('配置文件引用未知成员。');const relativePath=portableIniPath(f.relativePath),identity=f.key+'\0'+relativePath.normalize('NFC').toLowerCase();if(seen.has(identity))throw new Error('配置文件路径重复。');seen.add(identity);return {key:f.key,relativePath,sha256:hex(f.sha256)};});const compatible:Record<string,string>=Object.create(null);for(const [key,digest]of Object.entries(p.compatible)){if(!keys.has(key))throw new Error('配置兼容证据引用未知成员。');compatible[key]=hex(digest);}for(const f of files)if(!Object.hasOwn(compatible,f.key))throw new Error('缺少配置兼容证据。');profile={files,compatible};}
 return {format:'kmm-preset',schemaVersion:1,gameId:value.gameId,name:safeName(value.name),members,...(profile?{profile}:{})};
}
export function validateProfileBlobs(manifest:PortablePreset,blobs:Map<string,Buffer>){
 let total=0;const expected=new Set(manifest.profile?.files.map(f=>f.sha256)||[]);
 if(blobs.size!==expected.size||[...blobs.keys()].some(key=>!expected.has(key)))throw new Error('配置包包含缺失或额外的字节副本。');
 for(const [key,bytes]of blobs)if(bytes.length>PRESET_LIMITS.ini||(total+=bytes.length)>PRESET_LIMITS.iniTotal||sha(bytes)!==key)throw new Error('配置副本大小或 SHA256 不符。');
}
export function encodePresetPackage(manifest:PortablePreset,blobs:Map<string,Buffer>){
 validateProfileBlobs(manifest,blobs);const json=Buffer.from(JSON.stringify(manifest,null,2));if(json.length>PRESET_LIMITS.json)throw new Error('导出清单超过 4 MiB。');
 if(!manifest.profile)return json;
 const chunks:Buffer[]=[];let total=0;const zip=new Zip((error,bytes)=>{if(error)throw error;if((total+=bytes.length)>PRESET_LIMITS.zip)throw new Error('配置 ZIP 超过 80 MiB。');chunks.push(Buffer.from(bytes));});
 for(const [name,bytes]of [['manifest.json',json],...[...blobs].map(([digest,bytes])=>['blobs/'+digest+'.ini',bytes])] as [string,Buffer][]){const entry=new ZipPassThrough(name);zip.add(entry);entry.push(bytes,true);}zip.end();return Buffer.concat(chunks);
}
export async function readPresetPackage(file:string,signal?:AbortSignal){
 signal?.throwIfAborted();
 await assertNoLinks(file);const stat=await fs.stat(file);if(!stat.isFile())throw new Error('请选择预设清单文件。');
 if(/\.json$/i.test(file)){if(stat.size>PRESET_LIMITS.json)throw new Error('清单超过 4 MiB。');const manifest=readPortablePreset(parseUniqueJson(await fs.readFile(file))),blobs=new Map<string,Buffer>();validateProfileBlobs(manifest,blobs);return {manifest,blobs};}
 if(!/\.zip$/i.test(file)||stat.size>PRESET_LIMITS.zip)throw new Error('请选择不超过 80 MiB 的预设配置 ZIP。');
 const zip=await new Promise<yauzl.ZipFile>((resolve,reject)=>yauzl.open(file,{lazyEntries:true,autoClose:true,validateEntrySizes:true},(error,result)=>error?reject(error):resolve(result!)));
 return new Promise<{manifest:PortablePreset;blobs:Map<string,Buffer>}>((resolve,reject)=>{
  const entries=new Map<string,Buffer>();let total=0,finished=false;
  const fail=(error:unknown)=>{if(finished)return;finished=true;zip.close();signal?.removeEventListener('abort',aborted);reject(error);};
  const aborted=()=>fail(signal?.reason||new Error('已取消读取。'));signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted){aborted();return;}
  zip.on('error',fail);zip.on('entry',entry=>{void(async()=>{
   const name=entry.fileName,mode=(entry.externalFileAttributes>>>16)&0xf000;
   if(mode&&mode!==0x8000||!(/^(manifest\.json|blobs\/[a-f0-9]{64}\.ini)$/.test(name))||entries.has(name)||entries.size>=2049||entry.uncompressedSize>(name==='manifest.json'?PRESET_LIMITS.json:PRESET_LIMITS.ini))throw new Error('配置 ZIP 包含非法、重复或超限文件。');
   const stream=await new Promise<import('node:stream').Readable>((res,rej)=>zip.openReadStream(entry,(error,input)=>error?rej(error):res(input!)));const chunks:Buffer[]=[];let size=0;
   try{for await(const chunk of stream){signal?.throwIfAborted();size+=chunk.length;total+=chunk.length;if(size>(name==='manifest.json'?PRESET_LIMITS.json:PRESET_LIMITS.ini)||total>PRESET_LIMITS.output)throw new Error('配置包实际解压量超出预算。');chunks.push(Buffer.from(chunk));}}finally{stream.destroy();}
   if(size!==entry.uncompressedSize)throw new Error('配置包文件长度不符。');entries.set(name,Buffer.concat(chunks));if(!finished)zip.readEntry();
  })().catch(fail);});
  zip.on('end',()=>{try{signal?.throwIfAborted();if(!entries.has('manifest.json'))throw new Error('配置包缺少 manifest.json。');const manifest=readPortablePreset(parseUniqueJson(entries.get('manifest.json')!)),blobs=new Map([...entries].filter(([name])=>name!=='manifest.json').map(([name,bytes])=>[path.basename(name,'.ini'),bytes]));validateProfileBlobs(manifest,blobs);if(!finished){finished=true;signal?.removeEventListener('abort',aborted);resolve({manifest,blobs});}}catch(error){fail(error);}});zip.readEntry();
 });
}
