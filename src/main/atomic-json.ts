import {promises as fs} from 'node:fs';
import path from 'node:path';
import {assertNoLinks} from './archive';
import {createHash} from 'node:crypto';

// Callers serialize writes. Never unlink the current JSON to work around a Windows lock.
export async function writeAtomicFile(file:string,payload:string|Buffer,expected?:string):Promise<void> {
 await assertNoLinks(file);await assertNoLinks(file+'.tmp');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',payload,'utf8');
 for(let attempt=0;;attempt++){
  try{await assertNoLinks(file);await assertNoLinks(file+'.tmp');if(expected==='missing'){let exists=true;try{await fs.lstat(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw error;}if(exists)throw new Error('文件在准备期间被其它操作创建，原内容保持。');}else if(expected!==undefined&&createHash('sha256').update(await fs.readFile(file)).digest('hex')!==expected)throw new Error('文件在准备期间被其它操作修改，原内容保持。');await fs.rename(file+'.tmp',file);return;}catch(error){
   const code=(error as NodeJS.ErrnoException).code;
   if(process.platform!=='win32'||attempt>=7||!['EPERM','EACCES','EBUSY'].includes(code||''))throw error;
   await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
  }
 }
}
export function writeAtomicJson(file:string,payload:string){return writeAtomicFile(file,payload);}
