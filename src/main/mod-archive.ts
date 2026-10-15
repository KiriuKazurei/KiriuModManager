import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import * as yauzl from 'yauzl';
import {path7z} from '7zip-bin-full';
import {extractZip,containedPath,assertNoLinks} from './archive';
import {inspectModTree} from './content-fingerprint';
const execute=promisify(execFile),MAX_BYTES=2*1024**3;
export async function inspectModArchive(source:string,signal?:AbortSignal){
 signal?.throwIfAborted();await assertNoLinks(source);const extension=path.extname(source).toLowerCase();
 let count=0,bytes=0;const seen=new Map<string,boolean>(),parents=new Set<string>();
 const entry=(name:string,size:number,directory:boolean)=>{
  signal?.throwIfAborted();containedPath(path.dirname(source),name);
  const parts=name.replaceAll('\\','/').replace(/\/$/,'').split('/');
  if(parts.length>32||parts.some(part=>!part||part==='.'||/[<>:"|?*\x00-\x1f]/.test(part)||/[. ]$/.test(part)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))throw new Error('压缩包含 Windows 不安全或歧义路径。');
  const key=parts.join('/').normalize('NFC').toLowerCase();if(seen.has(key))throw new Error('压缩包包含重复或 Unicode 冲突路径。');
  for(let i=1;i<parts.length;i++)if(seen.get(parts.slice(0,i).join('/').normalize('NFC').toLowerCase())===false)throw new Error('压缩包文件与目录路径冲突。');
  if(!directory&&parents.has(key))throw new Error('压缩包文件与目录路径冲突。');
  for(let i=1;i<parts.length;i++)parents.add(parts.slice(0,i).join('/').normalize('NFC').toLowerCase());
  seen.set(key,directory);bytes+=size;if(!Number.isSafeInteger(size)||size<0||++count>50000||bytes>MAX_BYTES)throw new Error('压缩包超出 50000 项 / 2 GiB 限制。');
 };
 if(extension==='.zip'){
  const zip=await new Promise<yauzl.ZipFile>((resolve,reject)=>yauzl.open(source,{lazyEntries:true,validateEntrySizes:true},(error,file)=>error?reject(error):resolve(file!)));
  await new Promise<void>((resolve,reject)=>{let ended=false;const fail=(error:Error)=>{if(ended)return;ended=true;signal?.removeEventListener('abort',abort);zip.close();reject(error);};const abort=()=>fail(new Error('压缩包检查已取消。'));signal?.addEventListener('abort',abort,{once:true});zip.on('error',fail);zip.on('end',()=>{if(!ended){ended=true;signal?.removeEventListener('abort',abort);resolve();}});zip.on('entry',(row:yauzl.Entry)=>{try{const mode=(row.externalFileAttributes>>>16)&0xf000;if(mode&&mode!==0x8000&&mode!==0x4000||row.generalPurposeBitFlag&1)throw new Error('压缩包含链接、特殊文件或加密内容。');entry(row.fileName,row.uncompressedSize,row.fileName.endsWith('/'));zip.readEntry();}catch(error){fail(error as Error);}});zip.readEntry();});
 }else if(['.7z','.rar'].includes(extension)){
  let listing:string;try{listing=(await execute(path7z,['l','-slt','-ba','-sccUTF-8','-p-','--',source],{windowsHide:true,timeout:60000,maxBuffer:32*1024**2,signal})).stdout;}catch(error){signal?.throwIfAborted();throw new Error('压缩包无法读取，可能损坏或需要密码。');}
  for(const block of listing.split(/\r?\n\r?\n/)){const name=/^Path = (.+)$/m.exec(block)?.[1]?.replace(/\r$/,'');if(!name)continue;if(/^(Symbolic Link|Hard Link) = /m.test(block)||/^Attributes = .*\bl[rwx-]{9}/m.test(block)||/^Encrypted = \+/m.test(block))throw new Error('压缩包含链接或加密内容。');entry(name,Number(/^Size = (\d+)/m.exec(block)?.[1]||0),/^Folder = \+|^Attributes = D/m.test(block));}
 }else throw new Error('请选择 ZIP、7z 或 RAR 压缩包。');
 if(!count)throw new Error('压缩包为空。');return {files:count,bytes};
}
export async function extractModArchive(source:string,destination:string,signal?:AbortSignal):Promise<void>{
 await inspectModArchive(source,signal);await assertNoLinks(destination);await fs.mkdir(destination,{recursive:true});
 if(path.extname(source).toLowerCase()==='.zip')await extractZip(source,destination,signal);
 else{
  const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  let checking=false,overrun:Error|undefined;
  const check=async()=>{if(checking)return;checking=true;try{const tree=await inspectModTree(destination);if(tree.bytes>MAX_BYTES)throw new Error('实际解包输出超过 2 GiB。');}catch(error){overrun=error as Error;controller.abort();}finally{checking=false;}};
  const timer=setInterval(()=>void check(),200);
  try{await execute(path7z,['x','-y','-p-','-sccUTF-8',`-o${destination}`,'--',source],{windowsHide:true,timeout:120000,maxBuffer:4*1024**2,signal:controller.signal});if(overrun)throw overrun;}
  catch(error){signal?.throwIfAborted();throw overrun||new Error('解包失败，请检查压缩包、密码与磁盘空间。');}
  finally{clearInterval(timer);signal?.removeEventListener('abort',abort);}
 }
 signal?.throwIfAborted();const tree=await inspectModTree(destination,signal);if(tree.bytes>MAX_BYTES)throw new Error('实际解包输出超过 2 GiB。');
}
