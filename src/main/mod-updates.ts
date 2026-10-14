import {randomUUID,createHash} from 'node:crypto';
import type {GameId,ModUpdateCheck,ModUpdateTarget} from '../shared/contracts';
import {ModService,selectedModIds} from './mods';
import {readGameBananaMod,bindGameBananaFile,submissionId,GameBananaDownload,resolveGameBananaFile,GAMEBANANA_GAME_IDS} from './gamebanana';
import {compareVersions} from '../shared/mod-library';

export class ModUpdates {
 private candidates=new Map<string,{game:GameId;root:string;id:string;revision:string;binding:GameBananaDownload;expires:number}>();
 private running:Promise<unknown>|null=null;
 constructor(private mods:ModService,private fetcher:typeof fetch){}
 async check(game:GameId,ids:string[]):Promise<ModUpdateCheck[]>{
  selectedModIds(ids);if(this.running)throw new Error('正在检查 Mod 更新，请等待。');
  const work=this.checkAll(game,ids);this.running=work;try{return await work;}finally{this.running=null;}
 }
 private async checkAll(game:GameId,ids:string[]):Promise<ModUpdateCheck[]>{
  const library=await this.mods.scan(game);const mods=ids.map(id=>{const mod=library.mods.find(m=>m.id===id);if(!mod)throw new Error('更新检查成员已缺失。');return mod;});const requests=new Map<number,Promise<Record<string,any>>>();let cursor=0;const results:ModUpdateCheck[]=[];
  await Promise.all(Array.from({length:Math.min(3,mods.length)},async()=>{for(;;){const index=cursor++;if(index>=mods.length)return;const mod=mods[index];const remote=mod.remote;
   if(!remote||submissionId(mod.provenance.sourceUrl)!==remote.modId){results[index]={modId:mod.id,status:'manual',message:remote?'来源地址与网站绑定不一致，请人工核对。':'没有可靠网站文件绑定，请从来源页手动检查。',candidates:[]};continue;}
   try{let request=requests.get(remote.modId);if(!request){request=readGameBananaMod(this.fetcher,remote.modId);requests.set(remote.modId,request);}const response=await request;if(response._idRow!==remote.modId||response._aGame?._idRow!==GAMEBANANA_GAME_IDS[game])throw new Error('来源所属游戏或身份不符。');if(Array.isArray(response._aFiles)&&response._aFiles.length>200)throw new Error('来源文件选项超过 200 项，请从网站人工核对变体。');if(!Array.isArray(response._aFiles))throw new Error('站点未提供文件列表。');const bindings:GameBananaDownload[]=[];for(const file of response._aFiles){try{bindings.push(bindGameBananaFile(response,remote.modId,[file._sDownloadUrl],file._sFile,game));}catch{/* Unsupported external/unsafe files are not update candidates. */}}
    if(!bindings.length)throw new Error('没有可可靠绑定的托管压缩包，请手动核对来源。');const sameFile=bindings.find(b=>b.remote.fileId===remote.fileId),newFiles=bindings.filter(b=>b.remote.fileId!==remote.fileId);const changed=!!sameFile&&(sameFile.size!==remote.size||sameFile.remote.checksum!==remote.checksum);const version=String(response._sVersion||'');const newer=compareVersions(version,mod.provenance.version)===1;
    for(const [key,item]of this.candidates)if(item.expires<Date.now())this.candidates.delete(key);if(this.candidates.size+bindings.length>10000)throw new Error('候选缓存已达上限，请缩小本次检查范围或稍后重试。');const candidates=bindings.map(binding=>{const id=randomUUID();this.candidates.set(id,{game,root:library.root,id:mod.id,revision:mod.contentRevision!,binding,expires:Date.now()+10*60*1000});return {id,remote:binding.remote,version:binding.version};});
    results[index]={modId:mod.id,status:newer?'newer':changed?'changed':newFiles.length?'options':'current',message:newer?`来源声明版本 ${version} 高于 ${mod.provenance.version}；请选择与你的变体一致的文件。`:changed?'原文件的大小或摘要已改变，请核对后选择。':newFiles.length?'站点有其它文件可选；新增文件不能证明是当前变体的更新。':'没有发现可确认的版本或文件变化。',candidates};
   }catch(error){results[index]={modId:mod.id,status:'error',message:(error as Error).message,candidates:[]};}
  }}));for(const [key,value]of this.candidates)if(value.expires<Date.now())this.candidates.delete(key);return results;
 }
 async prepare(game:GameId,id:string,candidateId:string):Promise<{binding:GameBananaDownload;target:ModUpdateTarget;root:string}>{const item=this.candidates.get(candidateId);if(!item||item.game!==game||item.id!==id||item.expires<Date.now())throw new Error('更新候选已过期，请重新检查。');const {data,record}=await this.mods.context(game,id);if(data.root.toLowerCase()!==item.root.toLowerCase()||record!.contentRevision!==item.revision)throw new Error('Mod 或目标目录已改变，请重新检查。');const binding=await resolveGameBananaFile(this.fetcher,item.binding.remote.modId,[item.binding.remote.downloadUrl],item.binding.remote.fileName,undefined,game);if(JSON.stringify(binding)!==JSON.stringify(item.binding))throw new Error('站点文件在预览后改变，请重新检查。');return {binding,target:{modId:id,contentRevision:item.revision,candidateVersion:binding.version,root:item.root,candidateFingerprint:createHash('sha256').update(JSON.stringify(binding)).digest('hex')},root:item.root};}
}
