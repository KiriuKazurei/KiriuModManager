import type {ModRequirements} from './contracts';

export function normalizeTags(input:unknown):string[]{
 if(!Array.isArray(input)||input.length>20)throw new Error('标签最多 20 个。');
 const result:string[]=[];const seen=new Set<string>();
 for(const raw of input){if(typeof raw!=='string')throw new Error('标签格式无效。');const tag=raw.normalize('NFC').trim();if(!tag||tag.length>40||/[\x00-\x1f\x7f]/.test(tag))throw new Error('标签须为 1–40 个字符，不能包含控制字符。');const key=tag.toLocaleLowerCase();if(!seen.has(key)){seen.add(key);result.push(tag);}}
 return result;
}
export function numericVersion(value:string):number[]|null {if(!/^v?\d+(?:\.\d+){0,7}$/i.test(value.trim()))return null;const result=value.trim().replace(/^v/i,'').split('.').map(Number);return result.every(Number.isSafeInteger)?result:null;}
export function compareVersions(a:string,b:string):number|null {const x=numericVersion(a),y=numericVersion(b);if(!x||!y)return null;for(let i=0;i<Math.max(x.length,y.length);i++){const difference=(x[i]||0)-(y[i]||0);if(difference)return Math.sign(difference);}return 0;}
export function readRequirements(input:unknown):ModRequirements {
 const v=input as ModRequirements;
 if(!v||!Array.isArray(v.mods)||v.mods.length>100||!Array.isArray(v.components)||v.components.length>3||!['manual','author-stated'].includes(v.origin))throw new Error('依赖声明格式无效。');
 const text=(raw:unknown,optional=false)=>{if(raw===undefined&&optional)return undefined;if(typeof raw!=='string'||raw.length>200||/[\x00-\x1f\x7f]/.test(raw)||!raw.trim())throw new Error('版本或依赖身份无效。');return raw.trim();};
 const mods=v.mods.map(item=>({modId:text(item?.modId)!,...(item.minimumVersion?{minimumVersion:text(item.minimumVersion)!}:{})}));
 const components=v.components.map(item=>{if(!['launcher','xxmi','importer'].includes(item?.component))throw new Error('不支持的组件声明。');return {component:item.component,minimumVersion:text(item.minimumVersion)!};});
 if(new Set(mods.map(x=>x.modId)).size!==mods.length||new Set(components.map(x=>x.component)).size!==components.length)throw new Error('依赖声明不能重复。');
 if(v.note!==undefined&&(typeof v.note!=='string'||v.note.length>2000))throw new Error('依赖备注最多 2000 字符。');
 return {mods,components,origin:v.origin,...(v.gameVersion?{gameVersion:text(v.gameVersion)!}:{}),...(v.note?{note:v.note}:{})};
}
