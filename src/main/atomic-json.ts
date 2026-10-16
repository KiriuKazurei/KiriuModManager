import {promises as fs} from 'node:fs';
import path from 'node:path';
import {assertNoLinks} from './archive';
import {createHash} from 'node:crypto';

// Callers serialize writes. Never unlink the current JSON to work around a Windows lock.
export async function writeAtomicFile(file:string,payload:string|Buffer,expected?:string):Promise<void> {
 await assertNoLinks(file);await assertNoLinks(file+'.tmp');await fs.mkdir(path.dirname(file),{recursive:true});
 // Windows AppData virtualization can map a logical C: path to another volume.
 // Resolve the existing parent before creating the temporary file so rename stays on that volume.
 const directory=await fs.realpath(path.dirname(file)),target=path.join(directory,path.basename(file)),temporary=target+'.tmp';
 const identity=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
 await assertNoLinks(target);await assertNoLinks(temporary);
 try{if(identity(await fs.realpath(file))!==identity(target))throw new Error('文件与父目录的实际路径不一致，已保留原文件。');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 await fs.writeFile(temporary,payload,'utf8');
 for(let attempt=0;;attempt++){
  try{await assertNoLinks(file);await assertNoLinks(file+'.tmp');await assertNoLinks(target);await assertNoLinks(temporary);if(identity(await fs.realpath(path.dirname(file)))!==identity(directory))throw new Error('文件父目录在准备期间发生变化，原内容保持。');if(expected==='missing'){let exists=true;try{await fs.lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw error;}if(exists)throw new Error('文件在准备期间被其它操作创建，原内容保持。');}else if(expected!==undefined&&createHash('sha256').update(await fs.readFile(target)).digest('hex')!==expected)throw new Error('文件在准备期间被其它操作修改，原内容保持。');await fs.rename(temporary,target);return;}catch(error){
   const code=(error as NodeJS.ErrnoException).code;
   if(process.platform!=='win32'||attempt>=7||!['EPERM','EACCES','EBUSY'].includes(code||''))throw error;
   await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
  }
 }
}
export function writeAtomicJson(file:string,payload:string){return writeAtomicFile(file,payload);}
