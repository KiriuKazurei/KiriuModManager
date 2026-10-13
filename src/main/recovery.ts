import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GameId, GAMES, RecoveryItem } from '../shared/contracts';
import { assertNoLinks, containedPath } from './archive';
export interface RecoveryRecord extends RecoveryItem { version:1; modId?:string; record?:unknown; iniPath?:string }
export class RecoveryStore {
 constructor(readonly directory:string){}
 private folder(game:GameId){if(typeof game!=='string'||!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');return path.join(this.directory,'removed',game);}
 async create(game:GameId,input:Omit<RecoveryRecord,'id'|'version'|'gameId'|'createdAt'>,copy:(destination:string)=>Promise<void>){const id=randomUUID();const folder=this.folder(game);await assertNoLinks(folder);await fs.mkdir(folder,{recursive:true});const target=path.join(folder,id);await copy(target);const record:RecoveryRecord={...input,version:1,id,gameId:game,createdAt:new Date().toISOString()};await fs.writeFile(target+'.json',JSON.stringify(record,null,2));return record;}
 async list(game:GameId):Promise<RecoveryItem[]>{const folder=this.folder(game);await assertNoLinks(folder);let files:string[];try{files=await fs.readdir(folder);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}const items:RecoveryItem[]=[];const identified=new Set<string>();
 for(const file of files.filter(file=>file.endsWith('.json'))){const target=containedPath(folder,file);await assertNoLinks(target);let record:RecoveryRecord;try{record=JSON.parse(await fs.readFile(target,'utf8'));}catch{continue;}if(record.version===1&&record.gameId===game&&record.id+'.json'===file){identified.add(record.id);items.push({id:record.id,gameId:game,root:record.root,kind:record.kind,name:record.name,createdAt:record.createdAt,relativePath:record.relativePath,includesContent:record.includesContent});}}
 for(const file of files.filter(file=>!file.endsWith('.json')&&!identified.has(file))){const target=containedPath(folder,file);await assertNoLinks(target);const stat=await fs.stat(target);items.push({id:file,gameId:game,root:'',kind:'legacy',name:`旧版本副本 · ${file}`,createdAt:stat.mtime.toISOString(),includesContent:true,manualLocation:target});}
 return items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
 async read(game:GameId,id:string):Promise<{record:RecoveryRecord;payload:string}>{if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw new Error('恢复项目无效。');const payload=path.join(this.folder(game),id);await assertNoLinks(payload);await assertNoLinks(payload+'.json');const record=JSON.parse(await fs.readFile(payload+'.json','utf8')) as RecoveryRecord;if(record.version!==1||record.gameId!==game||record.id!==id)throw new Error('恢复项目与当前游戏不符。');return {record,payload};}
}
