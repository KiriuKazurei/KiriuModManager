import { GameId, GAMES } from '../shared/contracts';
export function validateUpdateSource(value:unknown):string {
 const source=validateWebUrl(value);
 if(source&&(new URL(source).protocol!=='https:'||source.includes('{')||source.includes('}')||new URL(source).hash))throw new Error('更新源须为不含占位符或片段的 HTTPS GitHub 仓库或更新清单地址。');
 return source;
}
export function validateWebUrl(value:unknown):string{if(typeof value!=='string'||value.length>4096||/[\r\n\0]/.test(value))throw new Error('网页地址格式无效。');const input=value.trim();if(!input)return '';let url:URL;try{url=new URL(input.replaceAll('{gameId}','zzz'));}catch{throw new Error('请填写完整 HTTP(S) 网页地址。');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('网页入口仅支持不含账号密码的 HTTP(S) 地址。');return input;}
export function resolveWebUrl(template:string,game:GameId,kind:'market'|'update'):string|null{if(typeof game!=='string'||!Object.hasOwn(GAMES,game)||!['market','update'].includes(kind))throw new Error('网页入口上下文无效。');const input=validateWebUrl(template);if(!input)return null;const url=new URL(input.replaceAll('{gameId}',game));if(!input.includes('{gameId}'))url.searchParams.set('gameId',game);return url.toString();}

