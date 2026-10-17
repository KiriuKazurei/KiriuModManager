import {net} from 'electron';
import type {FetchClient} from './releases';

// net.fetch cancels manual redirects instead of exposing their Location header.
// Return each hop to the updater so it can validate HTTPS before making the next request.
export const fetchUpdate:FetchClient=(url,options={})=>new Promise((resolve,reject)=>{
 if(options.signal?.aborted){reject(options.signal.reason);return;}
 const request=net.request({url,method:'GET',redirect:'manual',credentials:'omit'});
 let settled=false;let bodyEnded=false;let controller:ReadableStreamDefaultController<Uint8Array>|undefined;
 const failBody=(error:unknown)=>{if(controller&&!bodyEnded){bodyEnded=true;controller.error(error);}};
 const cleanup=()=>options.signal?.removeEventListener('abort',abort);
 const abort=()=>{const error=options.signal?.reason??new Error('更新请求已取消。');failBody(error);request.abort();if(!settled){settled=true;reject(error);}cleanup();};
 options.signal?.addEventListener('abort',abort,{once:true});
 request.on('error',error=>{if(!settled){settled=true;reject(error);}else failBody(error);cleanup();});
 const headers=(values:Record<string,string|string[]>)=>{const result=new Headers();for(const [key,value] of Object.entries(values))for(const item of Array.isArray(value)?value:[value])result.append(key,item);return result;};
 request.on('redirect',(status,_method,location,responseHeaders)=>{
  if(settled)return;
  const result=headers(responseHeaders);result.set('location',location);
  settled=true;resolve(new Response(null,{status,headers:result}));cleanup();request.abort();
 });
 request.on('response',response=>{
  if(settled)return;
  settled=true;
  const body=new ReadableStream<Uint8Array>({start(value){controller=value;},cancel(){bodyEnded=true;cleanup();request.abort();}});
  let bytes=0;
  response.on('end',()=>{if(!bodyEnded){bodyEnded=true;controller!.close();}cleanup();});
  response.on('error',error=>{failBody(error);cleanup();});response.on('aborted',()=>{failBody(new Error('更新响应被中止。'));cleanup();});
  response.on('data',chunk=>{if(bodyEnded)return;bytes+=chunk.length;if(bytes>512*1024**2){failBody(new Error('更新响应超过 512 MiB 限制。'));request.abort();return;}controller!.enqueue(chunk);});
  resolve(new Response([204,205,304].includes(response.statusCode)?null:body,{status:response.statusCode,headers:headers(response.headers)}));
 });
 try{new Headers(options.headers).forEach((value,key)=>request.setHeader(key,value));request.end();}
 catch(error){settled=true;cleanup();request.abort();reject(error);}
});
