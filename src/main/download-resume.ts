import type {DownloadItem} from 'electron';
import {createHash,randomUUID,type Hash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {assertNoLinks} from './archive';
import {gameBananaUrl,MAX_MOD_DOWNLOAD} from './gamebanana';

export interface DownloadResume {urlChain:string[];mimeType:string;eTag:string;lastModified:string;startTime:number;length:number;offset:number;sha256:string}
export interface ResumeDownloadRequest extends Omit<DownloadResume,'sha256'> {path:string}
export interface ResumeCursor {offset:number;hash:Hash}
export function readResume(input:unknown):DownloadResume {
 const value=input as DownloadResume;
 if(!value||!Array.isArray(value.urlChain)||!value.urlChain.length||value.urlChain.length>20||!Number.isSafeInteger(value.length)||value.length<=0||value.length>MAX_MOD_DOWNLOAD||!Number.isSafeInteger(value.offset)||value.offset<=0||value.offset>=value.length||!Number.isFinite(value.startTime)||value.startTime<0||!/^[a-f0-9]{64}$/.test(value.sha256)||['mimeType','eTag','lastModified'].some(key=>typeof value[key as 'eTag']!=='string'||value[key as 'eTag'].length>4096||/[\x00-\x1f]/.test(value[key as 'eTag'])))throw new Error('下载恢复记录无效。');
 const urlChain=value.urlChain.map(url=>{if(typeof url!=='string'||url.length>16384)throw new Error('恢复来源无效。');return gameBananaUrl(url,true).href;});
 return {...value,urlChain};
}
export function nativeResume(item:DownloadItem):Omit<DownloadResume,'offset'|'sha256'>|undefined {
 try{if(typeof item.getETag!=='function')return;const length=item.getTotalBytes(),urlChain=item.getURLChain().map(url=>gameBananaUrl(url,true).href);if(!urlChain.length||urlChain.length>20||!Number.isSafeInteger(length)||length<=0||length>MAX_MOD_DOWNLOAD)return;return {length,urlChain,mimeType:item.getMimeType(),eTag:item.getETag(),lastModified:item.getLastModifiedTime(),startTime:item.getStartTime()};}catch{return;}
}
export function resumeSupported(record:DownloadResume|undefined){return !!record&&/^"[^"\r\n]+"$/.test(record.eTag)&&!!record.lastModified&&Number.isFinite(Date.parse(record.lastModified));}
export async function mirrorPartial(source:string,target:string,limit:number,cursor?:ResumeCursor):Promise<ResumeCursor>{
 await assertNoLinks(source);await assertNoLinks(target);const input=await fs.open(source,'r');let output;
 try{
  const stat=await input.stat();if(!stat.isFile()||stat.size>MAX_MOD_DOWNLOAD)throw new Error('下载片段格式或大小无效。');
  const end=Math.min(stat.size,limit),state=cursor??{offset:0,hash:createHash('sha256')};if(end<state.offset)throw new Error('下载片段已被截断，请重新下载。');
  output=await fs.open(target,cursor?'r+':'w');const buffer=Buffer.alloc(1024**2);
  while(state.offset<end){const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,end-state.offset),state.offset);if(!bytesRead)throw new Error('下载片段读取不完整。');let written=0;while(written<bytesRead){const result=await output.write(buffer,written,bytesRead-written,state.offset+written);if(!result.bytesWritten)throw new Error('下载片段写入失败。');written+=result.bytesWritten;}state.hash.update(buffer.subarray(0,bytesRead));state.offset+=bytesRead;}
  await output.sync();return state;
 }finally{await input.close();await output?.close();}
}
export async function validatePartial(file:string,record:DownloadResume):Promise<ResumeCursor>{
 await assertNoLinks(file);const input=await fs.open(file,'r');
 try{const before=await input.stat({bigint:true});if(!before.isFile()||before.size<BigInt(record.offset)||before.size>BigInt(MAX_MOD_DOWNLOAD))throw new Error('下载片段缺失或大小不符，请重新下载。');const state={offset:0,hash:createHash('sha256')},buffer=Buffer.alloc(1024**2);while(state.offset<record.offset){const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,record.offset-state.offset),state.offset);if(!bytesRead)throw new Error('下载片段不完整，请重新下载。');state.hash.update(buffer.subarray(0,bytesRead));state.offset+=bytesRead;}const after=await input.stat({bigint:true});if(before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||state.hash.copy().digest('hex')!==record.sha256)throw new Error('下载片段已改变，请重新下载。');return state;}finally{await input.close();}
}
export async function restorePartial(source:string,target:string,record:DownloadResume){
 await assertNoLinks(source);await assertNoLinks(target);const temporary=target+'.'+randomUUID()+'.resume-tmp';await assertNoLinks(temporary);
 const input=await fs.open(source,'r');let output;
 try{output=await fs.open(temporary,'wx');const before=await input.stat({bigint:true}),hash=createHash('sha256'),buffer=Buffer.alloc(1024**2);let offset=0;
  if(!before.isFile()||before.size<BigInt(record.offset)||before.size>BigInt(MAX_MOD_DOWNLOAD))throw new Error('下载片段大小不符，请重新下载。');
  while(offset<record.offset){const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,record.offset-offset),offset);if(!bytesRead)throw new Error('下载片段不完整，请重新下载。');let written=0;while(written<bytesRead){const result=await output.write(buffer,written,bytesRead-written,offset+written);if(!result.bytesWritten)throw new Error('无法保存恢复片段。');written+=result.bytesWritten;}hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
  const after=await input.stat({bigint:true});if(before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||hash.digest('hex')!==record.sha256)throw new Error('下载片段已改变，请重新下载。');
  await output.sync();await output.close();output=undefined;await assertNoLinks(target);await fs.rename(temporary,target);
 }finally{await input.close();await output?.close();await fs.rm(temporary,{force:true});}
}
export async function probeResume(fetcher:typeof fetch,record:DownloadResume,signal:AbortSignal){
 if(!resumeSupported(record))throw new Error('服务器未提供可靠的续传标识，请重新下载。');
 let url=record.urlChain.at(-1)!;
 for(let count=0;count<6;count++){
  gameBananaUrl(url,true);const response=await fetcher(url,{headers:{Range:`bytes=${record.offset}-${record.offset}`,'If-Range':record.eTag},redirect:'manual',signal});
  if([301,302,303,307,308].includes(response.status)){const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new Error('续传重定向无效，请重新下载。');url=gameBananaUrl(new URL(location,url).href,true).href;continue;}
  try{if(response.status!==206)throw new Error(response.status===200?'服务器不支持当前片段续传或资源已变化，请重新下载。':`无法继续下载（HTTP ${response.status}），请稍后重试或重新下载。`);if(response.headers.get('content-range')!==`bytes ${record.offset}-${record.offset}/${record.length}`||response.headers.get('etag')!==record.eTag||response.headers.get('last-modified')!==record.lastModified)throw new Error('服务器资源已变化，请重新下载。');return;}finally{await response.body?.cancel();}
 }
 throw new Error('续传重定向过多，请重新下载。');
}
