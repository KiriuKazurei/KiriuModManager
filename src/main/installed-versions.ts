import path from 'node:path';
import {GAMES,GameId} from '../shared/contracts';
import {fileBytes,sha} from './inspection-files';
export interface InstalledVersion {state:'known'|'missing'|'unreadable'|'invalid';version:string|null;path:string;digest?:string}
export async function inspectInstalledVersions(game:GameId,root:string){
 if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');
 const read=async(name:string):Promise<InstalledVersion>=>{const file=root&&path.isAbsolute(root)?path.join(root,'Resources','Packages',name,'Manifest.json'):'';if(!file)return {path:file,state:'missing',version:null};try{const bytes=await fileBytes(file);let value:unknown;try{value=JSON.parse(bytes.toString('utf8')).version;}catch{return {path:file,state:'invalid',version:null,digest:sha(bytes)};}return typeof value==='string'&&value.trim()&&value.length<200?{path:file,state:'known',version:value,digest:sha(bytes)}:{path:file,state:'invalid',version:null,digest:sha(bytes)};}catch(error){return {path:file,state:(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unreadable',version:null};}};
 const [launcher,xxmi,importer]=await Promise.all(['Launcher','XXMI',GAMES[game].importer].map(read));return {launcher,xxmi,importer};
}
