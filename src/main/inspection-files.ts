import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertNoLinks} from './archive';
export const INSPECTION_LIMITS={nodes:200000,depth:32,iniBytes:4*1024**2,iniTotal:128*1024**2,iniFiles:10000,groups:2000,reportBytes:2*1024**2};
export interface TreeFile {relativePath:string;size:number;identity:string;digest?:string;directory:boolean}
export interface TreeEvidence {bytes:number;files:number;nodes:TreeFile[];complete:boolean;warnings:string[];fingerprint:string}
export const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export function isInside(root:string,target:string){const rel=path.relative(path.resolve(root),path.resolve(target));return !rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}
export async function fileBytes(file:string,limit=1024*1024){await assertNoLinks(file);const stat=await fs.stat(file);if(!stat.isFile()||stat.size>limit)throw new Error('文件类型或读取预算不符。');return fs.readFile(file);}
export async function optionalDigest(file:string){try{return sha(await fileBytes(file,16*1024**2));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return 'missing';throw error;}}
export async function treeEvidence(target:string,options:{signal?:AbortSignal;hashIni?:boolean;progress?:(message:string)=>void;maxNodes?:number}={}):Promise<TreeEvidence>{
 const result:TreeEvidence={bytes:0,files:0,nodes:[],complete:true,warnings:[],fingerprint:''};let iniBytes=0;
 const queue:{file:string;depth:number}[]=[{file:target,depth:0}];await assertNoLinks(target);
 const visit=async({file,depth}:{file:string;depth:number})=>{options.signal?.throwIfAborted();if(depth>INSPECTION_LIMITS.depth)throw new Error('目录深度超出盘点预算。');await assertNoLinks(file);const stat=await fs.lstat(file,{bigint:true});if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile())throw new Error('包含链接或特殊文件，未跟随。');const relativePath=path.relative(target,file);const entry:TreeFile={relativePath,size:Number(stat.size),identity:[stat.dev,stat.ino,stat.size,stat.mtimeNs].join(':'),directory:stat.isDirectory()};result.nodes.push(entry);
  if(stat.isDirectory()){for(const name of (await fs.readdir(file)).sort())queue.push({file:path.join(file,name),depth:depth+1});}else{result.files++;result.bytes+=Number(stat.size);if(options.hashIni&&/\.(ini|json)$/i.test(file)){if(stat.size>BigInt(INSPECTION_LIMITS.iniBytes)||iniBytes+Number(stat.size)>INSPECTION_LIMITS.iniTotal)result.warnings.push('部分配置超出摘要预算，仅保留文件身份／大小／时间证据，未比较内容。');else{iniBytes+=Number(stat.size);entry.digest=sha(await fs.readFile(file));}}}
 };
 while(queue.length){options.signal?.throwIfAborted();if(result.nodes.length+queue.length>(options.maxNodes??INSPECTION_LIMITS.nodes)){result.complete=false;result.warnings.push('节点数量超出盘点预算。');break;}const batch=queue.splice(0,4);const outcomes=await Promise.allSettled(batch.map(visit));for(const outcome of outcomes)if(outcome.status==='rejected'){options.signal?.throwIfAborted();result.complete=false;result.warnings.push((outcome.reason as Error).message.replace(/[A-Z]:\\[^\r\n]*/gi,'[路径]'));}if(result.nodes.length%100<4)options.progress?.(`已读取 ${result.nodes.length} 项`);}
 result.nodes.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));result.warnings=[...new Set(result.warnings)].slice(0,20);result.fingerprint=sha(JSON.stringify(result.nodes));return result;
}
