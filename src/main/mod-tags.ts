import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertNoLinks} from './archive';
import {normalizeTags} from '../shared/mod-library';
import {normalizeTagColors} from '../shared/mod-tags';
import {writeAtomicFile} from './atomic-json';

export function serializeModTags(tags:readonly string[],tagColors:Record<string,string>={}){
 const names=normalizeTags(tags),colors=normalizeTagColors(names,tagColors);
 return JSON.stringify({version:1,tags:names.map(name=>({name,color:colors[name]}))},null,2)+'\n';
}

export async function readModTags(directory:string,tags:string[]=[],colors:Record<string,string>={}){
 const file=path.join(directory,'tags.json');await assertNoLinks(file);
 let bytes:Buffer;
 try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.size>32768)throw new Error('tags.json 必须是不超过 32 KiB 的普通文件。');bytes=await fs.readFile(file);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {tags:normalizeTags(tags),tagColors:normalizeTagColors(tags,colors),expected:'missing'};throw error;}
 let value:{version:number;tags:{name:string;color:string}[]};
 try{value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));}catch{throw new Error('tags.json 不是有效的 JSON，原文件已保留。');}
 if(!value||value.version!==1||!Array.isArray(value.tags)||value.tags.length>20||value.tags.some(tag=>!tag||typeof tag.name!=='string'||typeof tag.color!=='string'))throw new Error('tags.json 标签格式无效，原文件已保留。');
 const names=normalizeTags(value.tags.map(tag=>tag.name));
 if(names.length!==value.tags.length||names.some((name,index)=>name!==value.tags[index].name))throw new Error('tags.json 含有重复或未规范化的标签，原文件已保留。');
 return {tags:names,tagColors:normalizeTagColors(names,Object.fromEntries(value.tags.map(tag=>[tag.name,tag.color]))),expected:createHash('sha256').update(bytes).digest('hex')};
}

export async function writeModTags(directory:string,tags:string[]=[],colors:Record<string,string>={}){
 await writeAtomicFile(path.join(directory,'tags.json'),serializeModTags(tags,colors));
}
