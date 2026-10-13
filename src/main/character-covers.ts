import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {GameId,GAMES} from '../shared/contracts';
import {CHARACTER_COVER_ASSETS} from '../shared/character-cover-manifest';
import {assertNoLinks,containedPath} from './archive';
import {ModService} from './mods';
export function characterCoverDirectory(data:string,game:GameId){if(typeof game!=='string'||!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');return path.join(data,'character-covers',game);}
export function imageType(bytes:Buffer){
 if(bytes.length<20||bytes.length>10*1024**2)throw new Error('角色封面须为有效图片，大小不超过 10 MB。');
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.length>=33)return 'png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217)return 'jpeg';
 if(/^GIF8[79]a$/.test(bytes.toString('ascii',0,6))&&bytes.readUInt16LE(6)>0&&bytes.readUInt16LE(8)>0)return 'gif';
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length&&/^VP8[ LX]$/.test(bytes.toString('ascii',12,16)))return 'webp';
 throw new Error('文件不是支持的 PNG、JPEG、WebP 或 GIF 图片。');
}
export class CharacterCoverService{
 constructor(private data:string,private assets:string,private mods:ModService,private decode?:(bytes:Buffer)=>boolean){}
 async read(game:GameId):Promise<Record<string,string>>{
  const library=await this.mods.scan(game);const references=await this.mods.characterCoverReferences(game);const result:Record<string,string>=Object.create(null);
  for(const name of library.characters){const custom=Object.hasOwn(references,name)?references[name]:undefined;const fixed=CHARACTER_COVER_ASSETS.find(entry=>entry.game===game&&entry.name===name);let file:string|undefined;
   if(custom){if(typeof custom!=='string'||!/^[a-f0-9]{64}\.(png|jpeg|webp|gif)$/.test(custom))throw new Error('角色封面记录格式无效。');file=containedPath(characterCoverDirectory(this.data,game),custom);}
   else if(fixed)file=containedPath(this.assets,fixed.file);
   if(file){await assertNoLinks(file);const stat=await fs.stat(file);if(!stat.isFile()||stat.size>10*1024**2)throw new Error('角色封面文件无效或过大。');const bytes=await fs.readFile(file);const type=imageType(bytes);result[name]=`data:image/${type};base64,${bytes.toString('base64')}`;}
  }return result;
 }
 async choose(game:GameId,name:string,source:string){const library=await this.mods.scan(game);if(typeof name!=='string'||!library.characters.includes(name))throw new Error('角色不存在，请返回概览重新扫描。');await assertNoLinks(source);const stat=await fs.stat(source);if(!stat.isFile()||stat.size>10*1024**2)throw new Error('角色封面须为图片，大小不超过 10 MB。');const bytes=await fs.readFile(source);const type=imageType(bytes);if(type!=='png'&&type!=='jpeg')throw new Error('自定义角色封面支持 PNG / JPEG，请先转换图片格式；默认立绘仍可使用 WebP。');if(this.decode&&!this.decode(bytes))throw new Error('图片无法解码，请选择完整有效的图片。');const directory=characterCoverDirectory(this.data,game);await assertNoLinks(directory);await fs.mkdir(directory,{recursive:true});const filename=createHash('sha256').update(name).digest('hex')+'.'+type;const output=containedPath(directory,filename);await assertNoLinks(output);await fs.writeFile(output,bytes);await this.mods.setCharacterCoverReference(game,name,filename);return this.mods.scan(game);}
}

