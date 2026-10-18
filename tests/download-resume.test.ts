import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import type {DownloadItem} from 'electron';
import {ModDownloads,type ModDownloadOptions} from '../src/main/mod-downloads';
import {readResume,probeResume,type ResumeDownloadRequest} from '../src/main/download-resume';
import type {GameId} from '../src/shared/contracts';
const urls=['https://gamebanana.com/dl/456','https://files.gamebanana.com/mods/example.zip'],lastModified='Sun, 18 Oct 2026 00:00:00 GMT';
const bytes=Buffer.alloc(8192,67),sha=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
class Item extends EventEmitter {
 file='';received=0;ended=false;paused=false;resumes=0;
 constructor(public offset=0,public tagged=true){super();this.received=offset;}
 native(){return this as unknown as DownloadItem;}getFilename(){return 'example.zip';}getSavePath(){return this.file;}setSavePath(file:string){this.file=file;}getTotalBytes(){return bytes.length;}getReceivedBytes(){return this.received;}
 getURLChain(){return urls;}getMimeType(){return 'application/zip';}getETag(){return this.tagged?'"fixture"':'';}getLastModifiedTime(){return this.tagged?lastModified:'';}getStartTime(){return 1792281600;}
 pause(){this.paused=true;}resume(){this.paused=false;this.resumes++;}
 cancel(){if(!this.ended){this.ended=true;rmSync(this.file,{force:true});this.emit('done',{},'cancelled');}}
 async push(size:number,finish=false){if(this.ended||this.paused)return;await fs.mkdir(path.dirname(this.file),{recursive:true});await fs.writeFile(this.file,bytes.subarray(0,size));this.received=size;this.emit('updated',{},'progressing');if(finish){this.ended=true;this.emit('done',{},'completed');}}
}
async function until(check:()=>boolean){const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('Task timed out');await new Promise(r=>setTimeout(r,5));}}
async function fixture(game:GameId='zzz'){
 const parent=path.resolve('.run-data/download-resume-tests');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-')),root=path.join(run,'Mods'),cache=path.join(run,'cache');await fs.mkdir(root);
 let restores=0,probes=0,mode='valid',restored:Item|undefined;
 const metadata=()=>({_idRow:123,_sName:'Resume fixture',_aGame:{_idRow:game==='zzz'?19567:21842},_aSubmitter:{_sName:'Fixture'},_sVersion:'1',_aRootCategory:{_sName:'Skins'},_aCategory:{_sName:'Other'},_aFiles:[{_idRow:456,_sFile:'example.zip',_nFilesize:bytes.length,_sDownloadUrl:urls[0],_sMd5Checksum:createHash('md5').update(bytes).digest('hex'),_sAvResult:'clean'}]});
 let downloads:ModDownloads;
 const options:ModDownloadOptions={cache,root:async()=>root,canStart:()=>true,confirmRoot:async()=>true,showFile:()=>{},requestDownload:()=>{},install:async()=>{throw new Error('Unexpected automatic install');},plan:async()=>({targetRoot:root,folders:[''],items:[{entryPath:'',folder:'',name:'Fixture',character:''}]}),fetch:async(_url,init)=>{const headers=new Headers(init?.headers);if(headers.has('Range')){probes++;const offset=Number(/bytes=(\d+)/.exec(headers.get('Range')!)![1]);return new Response('C',{status:mode==='no-range'?200:206,headers:{'content-range':`bytes ${offset}-${offset}/${bytes.length}`,etag:mode==='changed'?'"changed"':'"fixture"','last-modified':lastModified}});}return new Response(JSON.stringify(metadata()));},restoreDownload:(request:ResumeDownloadRequest)=>{restores++;restored=new Item(request.offset);restored.file=request.path;assert.equal(downloads.acceptResume(restored.native()),true);}};
 downloads=new ModDownloads(options);await downloads.initialize();return {run,root,cache,options,get downloads(){return downloads;},get restores(){return restores;},get probes(){return probes;},get restored(){return restored!;},setMode:(value:string)=>{mode=value;},async restart(){await downloads.close();downloads=new ModDownloads(options);await downloads.initialize();},async begin(tagged=true,update=false){const item=new Item(0,tagged);downloads.accept(item.native(),123,urls,game,update?{modId:randomUUID(),contentRevision:randomUUID(),candidateVersion:'2',root}:undefined);await until(()=>downloads.status().at(-1)?.stage==='downloading');await item.push(2048);return {item,id:downloads.status().at(-1)!.id};}};
}
for(const game of ['zzz','endfield'] as const)test(`${game}: pause retains the same task; resume after restart verifies the complete file without installing`,async()=>{
 const f=await fixture(game),{item,id}=await f.begin();await f.downloads.action(id,'pause');const paused=f.downloads.status()[0];assert.equal(paused.stage,'paused');assert.equal(paused.canResume,true);assert.equal(paused.resumableBytes,2048);assert.equal(f.downloads.hasActive(),false);await item.push(bytes.length,true);assert.equal(f.downloads.status()[0].receivedBytes,2048);
 await f.restart();assert.equal(f.restores,0);assert.equal(f.probes,0);assert.equal(f.downloads.status()[0].stage,'paused');await f.downloads.action(id,'resume');await until(()=>f.restored?.resumes===1);assert.equal(f.downloads.status().length,1);assert.equal(f.downloads.status()[0].id,id);assert.equal(f.downloads.status()[0].gameId,game);await f.restored.push(bytes.length,true);await until(()=>f.downloads.status()[0].stage==='ready');assert.equal(f.downloads.status()[0].archiveReady,true);assert.equal(sha(await fs.readFile(f.restored.file)),sha(bytes));await f.downloads.close();
});
test('normal shutdown checkpoints active bytes and restores as interrupted without automatically downloading',async()=>{
 const f=await fixture(),{id}=await f.begin();await f.restart();const row=f.downloads.status()[0];assert.equal(row.stage,'interrupted');assert.equal(row.canResume,true);assert.equal(row.resumableBytes,2048);assert.equal(f.restores,0);await f.downloads.action(id,'resume');await until(()=>f.restored?.resumes===1);await f.downloads.action(id,'cancel');assert.equal(f.downloads.status()[0].canResume,false);await f.downloads.close();
});
for(const mode of ['no-range','changed'])test(`resume refuses ${mode} resources without replacing the saved prefix`,async()=>{
 const f=await fixture(),{id}=await f.begin();await f.downloads.action(id,'pause');const partial=path.join(f.cache,id,'.kmm-resume.part'),before=await fs.readFile(partial);f.setMode(mode);await assert.rejects(f.downloads.action(id,'resume'),/重新下载/);assert.equal(f.restores,0);assert.deepEqual(await fs.readFile(partial),before);assert.equal(f.downloads.status()[0].stage,'paused');await f.downloads.close();
});
test('tampered or missing fragments are rejected before any server resume request',async()=>{
 const f=await fixture(),{id}=await f.begin();await f.downloads.action(id,'pause');await fs.writeFile(path.join(f.cache,id,'.kmm-resume.part'),Buffer.alloc(2048,2));await assert.rejects(f.downloads.action(id,'resume'),/片段已改变/);assert.equal(f.probes,0);assert.equal(f.restores,0);await fs.rm(path.join(f.cache,id,'.kmm-resume.part'));await assert.rejects(f.downloads.action(id,'resume'));await f.downloads.close();
});
test('missing server validators disables continuation; cancel discards only the owned recovery fragment',async()=>{
 const f=await fixture(),{id}=await f.begin(false);await f.downloads.action(id,'pause');assert.equal(f.downloads.status()[0].canResume,false);assert.match(f.downloads.status()[0].resumeMessage!,/重新下载/);await f.downloads.action(id,'cancel');assert.equal(f.downloads.status()[0].stage,'canceled');await assert.rejects(fs.stat(path.join(f.cache,id,'.kmm-resume.part')),{code:'ENOENT'});await assert.rejects(f.downloads.action(id,'resume'));await f.downloads.close();
});
test('resuming an update preserves the exact target and three-task concurrency limit',async()=>{
 const f=await fixture(),{id}=await f.begin(true,true);const target=f.downloads.status()[0].updateTarget;await f.downloads.action(id,'pause');for(let i=0;i<3;i++)await f.begin();await assert.rejects(f.downloads.action(id,'resume'),/3 个/);await f.downloads.action(f.downloads.status()[1].id,'pause');await f.downloads.action(id,'resume');assert.deepEqual(f.downloads.status()[0].updateTarget,target);await until(()=>f.restored?.resumes===1);await f.downloads.action(id,'cancel');await f.downloads.close();
});
test('resume records reject foreign URLs, partial-size abuse and invalid digests',async()=>{
 const valid={urlChain:urls,mimeType:'application/zip',eTag:'"fixture"',lastModified,startTime:0,length:100,offset:20,sha256:'a'.repeat(64)};readResume(valid);for(const value of [{...valid,urlChain:['https://evil.example/x.zip']},{...valid,offset:100},{...valid,sha256:'bad'},{...valid,offset:-1}])assert.throws(()=>readResume(value));let calls=0;await assert.rejects(probeResume(async()=>{calls++;return new Response();},readResume({...valid,eTag:''}),new AbortController().signal),/重新下载/);assert.equal(calls,0);
});
test('a resumable native interruption retains a checkpoint rather than becoming an unrecoverable failure',async()=>{
 const f=await fixture(),{item,id}=await f.begin();item.emit('updated',{},'interrupted');await until(()=>f.downloads.status()[0].stage==='interrupted'&&!!f.downloads.status()[0].canResume);await f.downloads.action(id,'resume');await until(()=>f.restored?.resumes===1);await f.restored.push(bytes.length,true);await until(()=>f.downloads.status()[0].stage==='ready');await f.downloads.close();
});
test('completion racing with pause still verifies the full package and stays pending for installation',async()=>{
 const f=await fixture(),{item,id}=await f.begin();item.pause=()=>{writeFileSync(item.file,bytes);item.received=bytes.length;item.ended=true;item.emit('done',{},'completed');};await f.downloads.action(id,'pause');await until(()=>f.downloads.status()[0].stage==='ready');assert.equal(f.downloads.status()[0].archiveReady,true);assert.equal(f.downloads.status()[0].canResume,false);await f.downloads.close();
});
test('a native server fallback that resets the received byte count is stopped and requires explicit redownload',async()=>{
 const f=await fixture(),{id}=await f.begin();await f.downloads.action(id,'pause');await f.downloads.action(id,'resume');await until(()=>f.restored?.resumes===1);f.restored.received=0;f.restored.emit('updated',{},'progressing');await until(()=>f.downloads.status()[0].stage==='interrupted');assert.equal(f.restored.ended,true);assert.equal(f.downloads.status()[0].canResume,false);assert.match(f.downloads.status()[0].message,/重新下载/);await f.downloads.close();
});
