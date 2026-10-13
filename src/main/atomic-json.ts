import {promises as fs} from 'node:fs';
import path from 'node:path';
import {assertNoLinks} from './archive';

// Callers serialize writes. Never unlink the current JSON to work around a Windows lock.
export async function writeAtomicJson(file:string,payload:string):Promise<void> {
 await assertNoLinks(file);await assertNoLinks(file+'.tmp');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file+'.tmp',payload,'utf8');
 for(let attempt=0;;attempt++){
  try{await fs.rename(file+'.tmp',file);return;}catch(error){
   const code=(error as NodeJS.ErrnoException).code;
   if(process.platform!=='win32'||attempt>=7||!['EPERM','EACCES','EBUSY'].includes(code||''))throw error;
   await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
  }
 }
}
