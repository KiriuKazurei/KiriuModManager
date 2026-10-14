import {createHash} from 'node:crypto';
import {createReadStream,promises as fs} from 'node:fs';
import path from 'node:path';
import type {GameId,ModMetadata,ModRemoteInfo} from '../shared/contracts';
import {GAMES} from '../shared/contracts';
import {CHARACTER_ALIASES,INITIAL_CHARACTERS} from '../shared/characters';
import {assertNoLinks} from './archive';

export const MAX_MOD_DOWNLOAD=2*1024**3;
export const GAMEBANANA_GAME_IDS:Record<GameId,number>={zzz:19567,endfield:21842};
export class ModDirectoryChangedError extends Error {constructor(){super('安装目录已改变，请明确选择当前目录后继续。');this.name='ModDirectoryChangedError';}}
export function gameBananaUrl(value:string,files=false):URL {
 const url=new URL(value);
 const host=url.hostname.toLowerCase();
 const allowed=host==='gamebanana.com'||host==='www.gamebanana.com'||files&&(/^(files|filecache\d+)\.gamebanana\.com$/.test(host));
 if(url.protocol!=='https:'||url.username||url.password||url.port||!allowed)throw new Error('仅支持 GameBanana 的 HTTPS 网页和托管下载。');
 return url;
}
export function submissionId(value:string):number|null {
 try{const url=gameBananaUrl(value);const match=/^\/mods\/(?:download\/)?([1-9]\d*)\/?$/.exec(url.pathname);const id=match?Number(match[1]):0;return Number.isSafeInteger(id)&&id>0?id:null;}catch{return null;}
}
export function downloadFileName(value:unknown):string {
 if(typeof value!=='string'||!value||value.length>240||path.basename(value)!==value||/[<>:"/\\|?*\x00-\x1f]/.test(value)||/[. ]$/.test(value)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)||!['.zip','.7z','.rar'].includes(path.extname(value).toLowerCase()))throw new Error('仅支持具有安全文件名的 ZIP、7z 或 RAR Mod 压缩包。');
 return value;
}
const text=(value:unknown,max:number)=>typeof value==='string'?value.replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&quot;/gi,'"').replace(/&#39;/g,"'").replace(/[\x00-\x1f]+/g,' ').trim().slice(0,max):'';
export interface GameBananaDownload {gameId:GameId;remote:ModRemoteInfo;version:string;size:number;metadata:Partial<ModMetadata>}
export function readRemoteInfo(input:unknown):ModRemoteInfo {
 const value=input as ModRemoteInfo;
 if(!value||value.provider!=='gamebanana'||!Number.isSafeInteger(value.modId)||value.modId<=0||!Number.isSafeInteger(value.fileId)||value.fileId<=0||!Number.isSafeInteger(value.size)||value.size<=0||value.size>MAX_MOD_DOWNLOAD)throw new Error('网站绑定记录格式无效。');
 for(const [field,max]of [['title',200],['author',200],['category',120],['description',5000]] as const)if(typeof value[field]!=='string'||value[field].length>max||/[\x00-\x1f]/.test(value[field]))throw new Error('网站绑定文本格式无效。');
 if(!value.title||typeof value.checksum!=='string'||!['md5',''].includes(value.checksumAlgorithm)||(value.checksumAlgorithm==='md5'?!/^[a-f0-9]{32}$/.test(value.checksum):!!value.checksum))throw new Error('网站绑定校验记录无效。');
 if(value.entryPath!==undefined&&(typeof value.entryPath!=='string'||value.entryPath.length>4096))throw new Error('网站绑定条目无效。');
 return {provider:'gamebanana',modId:value.modId,fileId:value.fileId,title:value.title,author:value.author,category:value.category,description:value.description,fileName:downloadFileName(value.fileName),downloadUrl:gameBananaUrl(value.downloadUrl,true).href,size:value.size,checksum:value.checksum,checksumAlgorithm:value.checksumAlgorithm,...(value.entryPath!==undefined?{entryPath:value.entryPath}:{})};
}
export function readDownloadBinding(input:unknown,expectedGame?:GameId):GameBananaDownload {
 const value=input as GameBananaDownload;const remote=readRemoteInfo(value?.remote);
 const gameId=value.gameId??'zzz';
 if(!Object.hasOwn(GAMEBANANA_GAME_IDS,gameId)||expectedGame!==undefined&&gameId!==expectedGame)throw new Error('网站绑定与任务游戏不匹配，未安装。');
 if(value.size!==remote.size||typeof value.version!=='string'||value.version.length>120||/[\x00-\x1f]/.test(value.version)||!value.metadata||typeof value.metadata!=='object'||Object.keys(value.metadata).some(key=>!['author','description','category','character'].includes(key))||Object.values(value.metadata).some(item=>typeof item!=='string'))throw new Error('下载绑定记录格式无效。');
 return {gameId,remote,version:value.version,size:value.size,metadata:{...value.metadata}};
}
export function bindGameBananaFile(input:unknown,modId:number,urls:string[],filename:string,gameId:GameId='zzz'):GameBananaDownload {
 const value=input as Record<string,any>;
 if(!Object.hasOwn(GAMEBANANA_GAME_IDS,gameId)||!Number.isSafeInteger(modId)||modId<=0||value?._idRow!==modId||value?._aGame?._idRow!==GAMEBANANA_GAME_IDS[gameId])throw new Error(`无法确认该下载属于${GAMES[gameId]?.name||'所选游戏'} Mod，未安装。`);
 if(!Array.isArray(value._aFiles))throw new Error('GameBanana 未返回 Mod 文件列表。');
 const chain=urls.map(url=>gameBananaUrl(url,true));
 const fileIds=chain.flatMap(url=>{const match=/^\/dl\/([1-9]\d*)\/?$/.exec(url.pathname);return match?[Number(match[1])]:[];});
 const matches=value._aFiles.filter(file=>fileIds.length?fileIds.includes(file?._idRow):chain.some(url=>url.href===file?._sDownloadUrl));
 if(matches.length!==1)throw new Error('下载文件无法与 Mod 页面唯一对应，未安装。');
 const file=matches[0];
 if(!Number.isSafeInteger(file._idRow)||file._idRow<=0||file._sFile!==downloadFileName(filename))throw new Error('下载文件名与站点记录不匹配。');
 if(!Number.isSafeInteger(file._nFilesize)||file._nFilesize<=0||file._nFilesize>MAX_MOD_DOWNLOAD)throw new Error('Mod 下载包大小无效或超过 2 GiB。');
 const downloadUrl=gameBananaUrl(file._sDownloadUrl,true).href;
 const md5=typeof file._sMd5Checksum==='string'?file._sMd5Checksum.toLowerCase():'';
 if(md5&&!/^[a-f0-9]{32}$/.test(md5))throw new Error('下载包校验信息无效。');
 if(file._sAvResult&& !['clean','unknown'].includes(file._sAvResult))throw new Error('网站报告该文件存在安全问题，未安装。');
 const credited=Array.isArray(value._aCredits)?value._aCredits.filter((group:any)=>['Key Authors','Authors'].includes(group?._sGroupName)).flatMap((group:any)=>Array.isArray(group._aAuthors)?group._aAuthors:[]).map((author:any)=>text(author?._sName,200)).filter(Boolean):[];
 const title=text(value._sName,200),author=(credited.length?[...new Set(credited)].join('、'):text(value._aSubmitter?._sName,200)).slice(0,200),category=text(value._aRootCategory?._sName||value._aCategory?._sName,120),description=text(value._sDescription||value._sText,5000);
 if(!title)throw new Error('Mod 名称信息缺失，未安装。');
 const remote:ModRemoteInfo={provider:'gamebanana',modId,fileId:file._idRow,title,author,category,description,fileName:filename,downloadUrl,size:file._nFilesize,checksum:md5,checksumAlgorithm:md5?'md5':''};
 const metadata:Partial<ModMetadata>={author,description};
 if(['Character Skins','Skins'].includes(category)) {
  metadata.category='角色';const raw=text(value._aCategory?._sName,120);const key=raw.toLowerCase().replace(/[\s_-]+/g,'');
  const known=CHARACTER_ALIASES[gameId][key]||INITIAL_CHARACTERS[gameId].find(name=>name===raw);
  if(known)metadata.character=known;
 }else{const categories:Record<string,string>={'User Interface':'UI',UI:'UI',Weapons:'武器',Maps:'场景'};if(categories[category])metadata.category=categories[category];}
 return {gameId,remote,version:text(value._sVersion,120),size:file._nFilesize,metadata};
}
export async function resolveGameBananaFile(fetcher:typeof fetch,modId:number,urls:string[],filename:string,signal?:AbortSignal,gameId:GameId='zzz'):Promise<GameBananaDownload> {
 return bindGameBananaFile(await readGameBananaMod(fetcher,modId,signal),modId,urls,filename,gameId);
}
export async function readGameBananaMod(fetcher:typeof fetch,modId:number,signal?:AbortSignal):Promise<Record<string,any>> {
 if(!Number.isSafeInteger(modId)||modId<=0)throw new Error('请先打开具体 Mod 页面，再点击该页面的下载。');
 const properties='_idRow,_sName,_aGame,_aSubmitter,_aCredits,_sVersion,_aFiles,_sDescription,_sText,_aCategory,_aRootCategory';
 const timeout=AbortSignal.timeout(30000);
 const response=await fetcher(`https://gamebanana.com/apiv11/Mod/${modId}?_csvProperties=${properties}`,{signal:signal?AbortSignal.any([signal,timeout]):timeout,redirect:'error',credentials:'include'});
 if(!response.ok)throw new Error(`读取 GameBanana Mod 信息失败（${response.status}），下载未安装。`);
 const size=Number(response.headers.get('content-length')||0);if(size>4*1024**2)throw new Error('Mod 信息响应过大。');
 const reader=response.body?.getReader();if(!reader)throw new Error('Mod 信息响应为空。');const chunks:Uint8Array[]=[];let bytes=0;
 try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>4*1024**2)throw new Error('Mod 信息响应过大。');chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function verifyModDownload(file:string,binding:GameBananaDownload):Promise<void> {
 await assertNoLinks(file);
 if((await fs.stat(file)).size!==binding.size)throw new Error('下载文件大小与网站记录不一致，未安装。');
 if(binding.remote.checksum){const hash=createHash('md5');for await(const chunk of createReadStream(file))hash.update(chunk);if(hash.digest('hex')!==binding.remote.checksum)throw new Error('下载文件校验失败，未安装。');}
}
