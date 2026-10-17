import path from 'node:path';
import {promises as fs} from 'node:fs';
import type {GameId,GamePaths} from '../shared/contracts';
import {normalizeGamePathInput} from '../shared/path-input';
import {assertNoLinks} from './archive';
import {requireGameExecutable} from './game-paths';

const labels={xxmiRoot:'XXMI 安装根目录',gameDirectory:'游戏目录',modsDirectory:'Mod 目录'};

export async function validateGamePathInput(game:GameId,field:keyof GamePaths,input:unknown):Promise<string> {
  const label=labels[field];
  if(typeof input!=='string'||input.length>32767||input.includes('\0'))throw new Error(`${label}：路径格式不正确。`);
  const original=input.trim().replace(/^"(.*)"$/, '$1').trim();
  const normalized=normalizeGamePathInput(game,field,input);
  if(!normalized)return '';
  if(!path.isAbsolute(normalized))throw new Error(`${label}：请填写完整的绝对目录路径。`);
  const executable=/\.exe$/i.test(original);
  if(executable) {
    if(field==='modsDirectory'||normalized===original)throw new Error(`${label}：请选择目录${field==='gameDirectory'?'或该游戏受支持的 EXE':field==='xxmiRoot'?'，或 Resources\\Bin\\XXMI Launcher.exe':''}，不能使用其它可执行文件。`);
    try {await assertNoLinks(original);if(!(await fs.stat(original)).isFile())throw new Error();}
    catch {throw new Error(`${label}：EXE 不存在、不可读或含链接，请重新选择安装位置。`);}
  }
  if(!executable&&normalized!==original){
    await assertNoLinks(original);
    try{if(!(await fs.stat(original)).isDirectory())throw new Error();}
    catch{throw new Error(`${label}：所选内层目录不存在或不是目录，请重新选择安装位置。`);}
  }
  const directory=path.resolve(normalized);
  try {
    await assertNoLinks(directory);
    if(!(await fs.stat(directory)).isDirectory())throw new Error(`${label}：当前路径是文件，请选择所在目录。`);
  } catch(error) {
    const code=(error as NodeJS.ErrnoException).code;
    // These directories may be created later by deployment or Mod management.
    if(code==='ENOENT'&&!executable&&field!=='gameDirectory'){
      let parent=path.dirname(directory);
      while(true){
        try {if(!(await fs.stat(parent)).isDirectory())throw new Error(`${label}：上级路径是文件，请重新选择目录。`);break;}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const next=path.dirname(parent);if(next===parent)throw error;parent=next;}
      }
      return directory;
    }
    if(code==='ENOENT'||code==='ENOTDIR')throw new Error(`${label}：目录不存在或上级路径是文件，请重新选择目录。`);
    throw error;
  }
  if(field==='gameDirectory')return (await requireGameExecutable(game,directory)).directory;
  return directory;
}
