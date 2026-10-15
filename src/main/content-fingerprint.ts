import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ModTreeHash} from '../shared/preset-workflows';
import {assertNoLinks,containedPath} from './archive';
import {sha} from './inspection-files';

export interface ContentBudget {remaining:number}
const identity=(stat:Awaited<ReturnType<typeof fs.lstat>>)=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
export async function inspectModTree(root:string,signal?:AbortSignal){
 await assertNoLinks(root);if(!(await fs.lstat(root)).isDirectory())throw new Error('Mod 来源不是普通目录。');
 const queue=[{file:root,relative:'',depth:0}],files:{relative:string;size:number;identity:string}[]=[],nodes:{relative:string;identity:string}[]=[],seen=new Set<string>();
 while(queue.length){
  signal?.throwIfAborted();if(nodes.length+queue.length>50000)throw new Error('Mod 文件数超过 50000 项预算。');
  const current=queue.shift()!;if(current.depth>32)throw new Error('Mod 目录深度超过 32 层。');
  await assertNoLinks(current.file);const stat=await fs.lstat(current.file);
  if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw new Error('Mod 包含链接或特殊文件。');
  nodes.push({relative:current.relative,identity:identity(stat)});
  if(stat.isDirectory())for(const name of await fs.readdir(current.file)){
   const relative=current.relative?current.relative+'/'+name:name,key=relative.normalize('NFC').toLowerCase();
   if(seen.has(key))throw new Error('Mod 包含大小写或 Unicode 冲突路径。');seen.add(key);
   queue.push({file:containedPath(root,relative),relative,depth:current.depth+1});
  }else files.push({relative:current.relative,size:stat.size,identity:identity(stat)});
 }
 files.sort((a,b)=>Buffer.compare(Buffer.from(a.relative),Buffer.from(b.relative)));nodes.sort((a,b)=>Buffer.compare(Buffer.from(a.relative),Buffer.from(b.relative)));
 return {files,bytes:files.reduce((sum,file)=>sum+file.size,0),structure:sha(JSON.stringify(files.map(f=>[f.relative,f.size]))),evidence:sha(JSON.stringify(nodes))};
}
const frame=(value:number)=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(value));return bytes;};
export async function hashModTree(root:string,budget:ContentBudget={remaining:8*1024**3},signal?:AbortSignal,overrides?:Map<string,Buffer>){
 const tree=await inspectModTree(root,signal),hash=createHash('sha256').update(overrides?'profile-compatible-v1':'mod-tree-v1');
 if(overrides&&[...overrides.keys()].some(name=>!tree.files.some(file=>file.relative===name)))throw new Error('独立配置的 INI 路径在目标 Mod 中不存在。');
 let total=0;const structure:unknown[]=[];
 for(const file of tree.files){
  signal?.throwIfAborted();const replacement=overrides?.get(file.relative),size=replacement?.length??file.size;
  if(size>budget.remaining)throw new Error('内容哈希读取超过 8 GiB 总预算，请缩小清单范围。');
  budget.remaining-=size;total+=size;structure.push([file.relative,size]);let digest:Buffer;
  if(replacement)digest=createHash('sha256').update(replacement).digest();
  else{
   const target=containedPath(root,file.relative);await assertNoLinks(target);const handle=await fs.open(target,'r');
   try{
    const stat=await handle.stat();if(!stat.isFile()||identity(stat)!==file.identity)throw new Error('Mod 文件在哈希准备期间已改变。');
    const content=createHash('sha256');let read=0;
    for await(const chunk of handle.createReadStream({autoClose:false,highWaterMark:256*1024})){signal?.throwIfAborted();read+=chunk.length;if(read>size)throw new Error('Mod 文件在哈希读取期间增长。');content.update(chunk);}
    if(read!==size||identity(await handle.stat())!==file.identity||identity(await fs.lstat(target))!==file.identity)throw new Error('Mod 文件在哈希读取期间已改变。');digest=content.digest();
   }finally{await handle.close();}
  }
  const name=Buffer.from(file.relative);hash.update(frame(name.length)).update(name).update(frame(size)).update(digest);
 }
 if((await inspectModTree(root,signal)).evidence!==tree.evidence)throw new Error('Mod 文件树在哈希读取期间已改变，请重新读取。');
 const value:ModTreeHash={algorithm:'mod-tree-v1',sha256:hash.digest('hex'),files:tree.files.length,bytes:total,structure:sha(JSON.stringify(structure))};
 return {hash:value,evidence:tree.evidence};
}
