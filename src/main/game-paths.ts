import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {GameId} from '../shared/contracts';
import {GAMES} from '../shared/contracts';
import {assertNoLinks} from './archive';
import {sha} from './inspection-files';
import {GAME_EXECUTABLE_NAMES} from '../shared/path-input';
export const GAME_ADAPTERS={zzz:{names:GAME_EXECUTABLE_NAMES.zzz},endfield:{names:GAME_EXECUTABLE_NAMES.endfield}} as const;
export interface GameResolution {root:string;matches:{executable:string;directory:string;identity:string}[];complete:boolean;issues:string[];visited:number;fingerprint:string}
export async function resolveGameInstallation(game:GameId,directory:string,options:{signal?:AbortSignal;maxEntries?:number;maxDepth?:number;timeoutMs?:number;quick?:boolean}={}):Promise<GameResolution>{
 if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');
 const result:GameResolution={root:directory,matches:[],complete:true,issues:[],visited:0,fingerprint:''};
 const finish=()=>{result.matches.sort((a,b)=>a.executable.localeCompare(b.executable));result.issues=[...new Set(result.issues)].slice(0,12);result.fingerprint=sha(JSON.stringify([directory,result.matches,result.complete,result.issues]));return result;};
 if(typeof directory!=='string'||!directory||!path.isAbsolute(directory)){result.complete=false;result.issues.push('请先保存该游戏的实际安装目录。');return finish();}
 const root=path.resolve(directory);if(root===path.parse(root).root){result.complete=false;result.issues.push('请直接选择游戏安装目录，不能搜索整个磁盘。');return finish();}
 // Launcher resolves supported names in the configured folder before recursive fallback.
 for(const name of GAME_ADAPTERS[game].names){options.signal?.throwIfAborted();const file=path.join(root,name);try{await assertNoLinks(file);const stat=await fs.stat(file,{bigint:true});if(stat.isFile())result.matches.push({executable:file,directory:root,identity:[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')});}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'')){result.complete=false;result.issues.push('已知 EXE 暂时不可读，请稍后重新查找。');}}}
 if(result.matches.length)return finish();
 if(options.quick){result.complete=false;result.issues.push('轻检查未确认已知位置；请查找候选或手动选择安装位置。');return finish();}
 const deadline=Date.now()+(options.timeoutMs??5000),limit=options.maxEntries??10000,depthLimit=options.maxDepth??12;
 const queue=[{folder:root,depth:0}],names=GAME_ADAPTERS[game].names.map(n=>n.toLowerCase());
 try{await assertNoLinks(root);if(!(await fs.stat(root)).isDirectory())throw new Error('游戏路径不是目录。');}catch{result.complete=false;result.issues.push('游戏目录不存在、不可读或含链接；原设置保持。');return finish();}
 scan:while(queue.length){options.signal?.throwIfAborted();if(Date.now()>deadline){result.complete=false;result.issues.push('查找超过时间预算，请缩小安装目录后重试。');break;}
  const {folder,depth}=queue.shift()!;
  try{await assertNoLinks(folder);const handle=await fs.opendir(folder);
   for await(const entry of handle){options.signal?.throwIfAborted();if(++result.visited>limit||Date.now()>deadline){result.complete=false;result.issues.push('查找超过目录项或时间预算；不能认定游戏缺失。');break scan;}
    const file=path.join(folder,entry.name);
    if(entry.isSymbolicLink()){result.complete=false;result.issues.push('存在链接目录/文件，未跟随；请直接选择普通游戏目录。');continue;}
    if(entry.isDirectory()){if(depth>=depthLimit){result.complete=false;result.issues.push('查找超过深度预算，请直接选择游戏目录。');}else queue.push({folder:file,depth:depth+1});}
    else if(entry.isFile()&&names.includes(entry.name.toLowerCase())){await assertNoLinks(file);const stat=await fs.stat(file,{bigint:true});result.matches.push({executable:file,directory:folder,identity:[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':')});}
   }
  }catch(error){options.signal?.throwIfAborted();result.complete=false;result.issues.push('部分游戏目录读取失败或查找时发生变化，请重查。');}
 }
 return finish();
}
export async function requireGameExecutable(game:GameId,directory:string,signal?:AbortSignal){const result=await resolveGameInstallation(game,directory,{signal});if(!result.complete)throw new Error(result.issues.join('；'));if(result.matches.length!==1)throw new Error('未找到唯一的'+GAMES[game].name+'游戏 EXE（'+GAME_ADAPTERS[game].names.join(' / ')+ '），请到路径设置的“检查与修复”中选择安装目录。');return result.matches[0];}
