import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {path7z} from '7zip-bin-full';
import {zipSync,strToU8} from 'fflate';
import type {DownloadItem} from 'electron';
import {ModService} from '../src/main/mods';
import {BusinessService} from '../src/main/business';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {ModDownloads} from '../src/main/mod-downloads';
import {bindGameBananaFile,gameBananaUrl,submissionId,verifyModDownload,readRemoteInfo,readDownloadBinding,ModDirectoryChangedError} from '../src/main/gamebanana';
import type {GameId} from '../src/shared/contracts';

const urls=['https://gamebanana.com/dl/456','https://files.gamebanana.com/mods/example.zip'];
const pack=()=>Buffer.from(zipSync({'First/main.ini':strToU8('[TextureOverride]\nhash=01234567'),'Second/main.ini':strToU8('[TextureOverride]\nhash=89abcdef')},{mtime:new Date('2026-01-01T00:00:00Z')}));
function endfieldInfo(bytes:Uint8Array){const value=info(bytes);return {...value,_sName:'Perlica Outfit',_aGame:{_idRow:21842},_aRootCategory:{_sName:'Skins'},_aCategory:{_sName:'Perlica'}};}
function info(bytes:Uint8Array,filename='example.zip'){return {_idRow:123,_sName:'Fixture Mod',_aGame:{_idRow:19567},_aSubmitter:{_sName:'站点作者'},_sVersion:'1.2',_sDescription:'<b>简介</b>',_aRootCategory:{_sName:'Character Skins'},_aCategory:{_sName:'Anby'},_aFiles:[{_idRow:456,_sFile:filename,_nFilesize:bytes.length,_sDownloadUrl:urls[0],_sMd5Checksum:createHash('md5').update(bytes).digest('hex'),_sAvResult:'clean'}]};}
async function write(file:string,bytes:string|Uint8Array){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
async function fixture(){
 const parent=path.resolve('.run-data/mod-download-tests');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-'));const store=new SettingsStore(path.join(run,'data'));const settings=defaultSettings();
 for(const game of ['zzz','endfield']as const){settings.games[game].modsDirectory=path.join(run,game,'Mods');await fs.mkdir(settings.games[game].modsDirectory,{recursive:true});}await store.save(settings);
 const mods=new ModService(path.join(run,'data'),async game=>(await store.read()).games[game]);const business=new BusinessService(path.join(run,'data'),mods,store);
 return {run,store,settings,mods,business,root:settings.games.zzz.modsDirectory};
}
class Item extends EventEmitter {
 file='';received=0;ended=false;
 constructor(public bytes:Uint8Array){super();}
 getFilename(){return 'example.zip';}getTotalBytes(){return this.bytes.length;}getReceivedBytes(){return this.received;}setSavePath(file:string){this.file=file;}
 cancel(){if(!this.ended){this.ended=true;this.emit('done',{},'cancelled');}}
 async finish(){if(this.ended)return;await write(this.file,this.bytes);this.received=this.bytes.length;this.emit('updated',{},'progressing');if(!this.ended){this.ended=true;this.emit('done',{},'completed');}}
 native(){return this as unknown as DownloadItem;}
}
async function waitUntil(check:()=>boolean){const end=Date.now()+6000;while(!check()){if(Date.now()>end)throw new Error('Timed out waiting for test task');await new Promise(resolve=>setTimeout(resolve,5));}}
async function manager(f:Awaited<ReturnType<typeof fixture>>,fetcher:typeof fetch=async()=>new Response(JSON.stringify(info(pack())),{headers:{'content-type':'application/json'}})){
 let confirm=true;const requests:{modId:number;url:string;gameId:GameId}[]=[];const shown:string[]=[];
 const options={cache:path.join(f.run,'data','mod-downloads'),fetch:fetcher,root:async(game:GameId)=>(await f.store.read()).games[game].modsDirectory,plan:(file:string,root:string,binding:Parameters<ModService['installDownload']>[3])=>f.mods.downloadInstallPlan(binding.gameId,file,root,binding),install:(file:string,root:string,binding:Parameters<ModService['installDownload']>[3],destinations?:Parameters<ModService['installDownload']>[4])=>f.mods.installDownload(binding.gameId,file,root,binding,destinations),canStart:()=>true,confirmRoot:async()=>confirm,requestDownload:(modId:number,url:string,gameId:GameId)=>requests.push({modId,url,gameId}),showFile:(file:string)=>shown.push(file)};
 const downloads=new ModDownloads(options);await downloads.initialize();return {downloads,options,requests,shown,setConfirm:(value:boolean)=>{confirm=value;}};
}
test('GameBanana URLs and detail/file identities reject foreign games, mismatches and unsafe downloads',()=>{
 const bytes=pack(),json=info(bytes);const binding=bindGameBananaFile(json,123,urls,'example.zip');assert.equal(binding.metadata.character,'安比');assert.equal(binding.metadata.description,'简介');assert.equal(binding.remote.fileId,456);assert.equal(submissionId('https://gamebanana.com/mods/download/123?x=1'),123);assert.equal(submissionId('https://gamebanana.com/mods/cats/123'),null);
 for(const url of ['http://gamebanana.com/dl/456','https://gamebanana.com.evil.test/dl/456','https://user:pass@gamebanana.com/mods/123','file:///C:/mods','https://127.0.0.1/mods/123'])assert.throws(()=>gameBananaUrl(url,true));
 for(const input of [{...json,_aGame:{_idRow:1}},{...json,_idRow:124},{...json,_aFiles:[]},{...json,_aFiles:[{...json._aFiles[0],_sFile:'x.exe'}]},{...json,_aFiles:[{...json._aFiles[0],_sAvResult:'infected'}]}])assert.throws(()=>bindGameBananaFile(input,123,urls,'example.zip'));
 assert.throws(()=>bindGameBananaFile(json,123,['https://gamebanana.com/dl/789'],'example.zip'));assert.throws(()=>readRemoteInfo({...binding.remote,downloadUrl:'file:///C:/mod.zip'}));
});
test('size/checksum verification rejects tampering and absent optional version/checksum stays honest',async()=>{
 const f=await fixture(),bytes=pack(),file=path.join(f.run,'example.zip');await write(file,bytes);const binding=bindGameBananaFile(info(bytes),123,urls,'example.zip');await verifyModDownload(file,binding);
 const corrupt=Buffer.from(bytes);corrupt[30]^=1;await write(file,corrupt);await assert.rejects(verifyModDownload(file,binding),/校验失败/);await write(file,bytes.subarray(0,20));await assert.rejects(verifyModDownload(file,binding),/大小/);
 const json=info(bytes);json._sVersion='';json._aFiles[0]._sMd5Checksum='';const optional=bindGameBananaFile(json,123,urls,'example.zip');assert.equal(optional.version,'');assert.equal(optional.remote.checksumAlgorithm,'');
});
test('online multi-Mod installs default disabled with durable binding and avoids duplicates after rename/classify',async()=>{
 const f=await fixture(),bytes=pack(),file=path.join(f.run,'example.zip');await write(file,bytes);const binding=bindGameBananaFile(info(bytes),123,urls,'example.zip');let result=await f.mods.installDownload('zzz',file,f.root,binding);assert.equal(result.importedIds.length,2);assert.deepEqual(result.errors,[]);
 for(const mod of result.library.mods){assert.equal(mod.enabled,false);assert.equal(mod.ownDisabled,true);assert.equal(mod.metadata.author,'站点作者');assert.equal(mod.metadata.character,'安比');assert.equal(mod.provenance.version,'1.2');assert.equal(mod.provenance.verification,'unverified');assert.equal(mod.provenance.sourceUrl,'https://gamebanana.com/mods/123');assert.ok(mod.remote?.entryPath);}
 const first=result.library.mods[0];await f.mods.operate('zzz',first.id,{kind:'rename',name:'Renamed'});await f.mods.operate('zzz',first.id,{kind:'classify',category:'收藏',character:'安比',appearance:''});result=await f.mods.installDownload('zzz',file,f.root,binding);assert.deepEqual(result.importedIds,[]);assert.equal(result.items.filter(item=>item.existing).length,2);assert.equal(result.library.mods.length,2);
 const restarted=new ModService(path.join(f.run,'data'),async game=>(await f.store.read()).games[game]);assert.equal((await restarted.scan('zzz')).mods.find(mod=>mod.id===first.id)?.remote?.fileId,456);assert.deepEqual((await restarted.scan('endfield')).mods,[]);
});
test('per-item collision preserves original content while later candidates install; retry only installs missing entries',async()=>{
 const f=await fixture(),bytes=pack(),file=path.join(f.run,'example.zip');await write(file,bytes);await write(path.join(f.root,'角色','安比','First','main.ini'),'existing');const binding=bindGameBananaFile(info(bytes),123,urls,'example.zip');let result=await f.mods.installDownload('zzz',file,f.root,binding);assert.equal(result.importedIds.length,1);assert.equal(result.items[0].ok,true);assert.equal((result.items[0] as any).state,'skipped');assert.equal(result.items[1].ok,true);assert.equal(await fs.readFile(path.join(f.root,'角色','安比','First','main.ini'),'utf8'),'existing');
 const original=result.library.mods.find(mod=>mod.name==='First')!;await f.mods.operate('zzz',original.id,{kind:'rename',name:'KeepOriginal'});result=await f.mods.installDownload('zzz',file,f.root,binding);assert.equal(result.importedIds.length,1);assert.equal(result.items.filter(item=>item.existing).length,1);assert.equal(result.library.mods.length,3);
});
test('online unsafe/no-INI archives and wrong target/game fail without installing content',async()=>{
 const f=await fixture();for(const bytes of [Buffer.from(zipSync({'../outside.ini':strToU8('unsafe')})),Buffer.from(zipSync({'readme.txt':strToU8('no ini')}))]){const file=path.join(f.run,'example.zip');await write(file,bytes);await assert.rejects(f.mods.installDownload('zzz',file,f.root,bindGameBananaFile(info(bytes),123,urls,'example.zip')));assert.deepEqual(await fs.readdir(f.root),[]);}
 const bytes=pack(),file=path.join(f.run,'example.zip');await write(file,bytes);const binding=bindGameBananaFile(info(bytes),123,urls,'example.zip');await assert.rejects(f.mods.installDownload('endfield',file,f.root,binding),/游戏不匹配/);await assert.rejects(f.mods.installDownload('zzz',file,path.join(f.run,'Other'),binding),ModDirectoryChangedError);
});
test('registry failure withdraws only newly committed content and keeps existing files intact',async()=>{
 const f=await fixture();await write(path.join(f.root,'Keep','main.ini'),'existing');const bytes=Buffer.from(zipSync({'Fresh/main.ini':strToU8('fresh')})),file=path.join(f.run,'example.zip');await write(file,bytes);const binding=bindGameBananaFile(info(bytes),123,urls,'example.zip');const original=fs.rename;let saves=0;
 fs.rename=async(from,to)=>{if(String(to)===path.join(f.run,'data','library-zzz.json')&&++saves===2)throw new Error('fixture registry failure');return original(from,to);};let result;
 try{result=await f.mods.installDownload('zzz',file,f.root,binding);}finally{fs.rename=original;}
 assert.equal(result.importedIds.length,0);assert.match(result.errors.join(' '),/registry failure/);assert.deepEqual((await f.mods.scan('zzz')).mods.map(mod=>mod.name),['Keep']);assert.equal(await fs.readFile(path.join(f.root,'Keep','main.ini'),'utf8'),'existing');
});
test('remote binding survives snapshot/recovery; local replacement clears current file binding and restores original snapshot',async()=>{
 const f=await fixture(),bytes=pack(),file=path.join(f.run,'example.zip');await write(file,bytes);const imported=await f.mods.installDownload('zzz',file,f.root,bindGameBananaFile(info(bytes),123,urls,'example.zip'));const first=imported.library.mods[0];const snapshot=(await f.business.createBackup('zzz','网站绑定'))[0];
 const replacement=path.join(f.run,'replacement');await write(path.join(replacement,'main.ini'),'replaced');let library=await f.mods.replace('zzz',first.id,replacement);assert.equal(library.mods.find(mod=>mod.id===first.id)?.remote,undefined);assert.equal(library.mods.find(mod=>mod.id===first.id)?.provenance.version,'');
 library=await f.business.restore('zzz',snapshot.id);assert.deepEqual(library.mods.find(mod=>mod.id===first.id)?.remote,first.remote);await f.mods.delete('zzz',first.id);const removed=(await f.business.recovery.list('zzz')).find(item=>item.kind==='mod-delete')!;library=await f.business.restore('zzz',removed.id);assert.deepEqual(library.mods.find(mod=>mod.id===first.id)?.remote,first.remote);
});
test('download events persist successful tasks, owned cache visibility and existing-item results across restart',async()=>{
 const f=await fixture(),m=await manager(f),item=new Item(pack());m.downloads.accept(item.native(),123,urls);await item.finish();await waitUntil(()=>!m.downloads.hasActive());let task=m.downloads.status()[0];assert.equal(task.stage,'ready');assert.deepEqual(await fs.readdir(f.root),[]);await m.downloads.action(task.id,'retry-install');task=m.downloads.status()[0];assert.equal(task.stage,'complete');assert.equal(task.archiveReady,true);assert.equal(task.importedIds.length,2);await m.downloads.action(task.id,'show-file');assert.deepEqual(m.shown,[item.file]);await m.downloads.close();const restarted=new ModDownloads(m.options);await restarted.initialize();assert.deepEqual(restarted.status(),m.downloads.status());await restarted.action(task.id,'retry-install');assert.match(restarted.status()[0].message,/已有 2 项/);await restarted.close();
});
test('directory changes wait for explicit confirmation and use latest saved target, keeping old target untouched',async()=>{
 const f=await fixture();let resolve!:(response:Response)=>void;const metadata=new Promise<Response>(done=>{resolve=done;});const m=await manager(f,async()=>metadata);const item=new Item(pack());m.downloads.accept(item.native(),123,urls);await waitUntil(()=>!!m.downloads.status()[0]?.targetRoot);const next=path.join(f.run,'NewMods');await fs.mkdir(next);await f.store.save({...f.settings,games:{...f.settings.games,zzz:{...f.settings.games.zzz,modsDirectory:next}}});await item.finish();resolve(new Response(JSON.stringify(info(pack()))));await waitUntil(()=>!m.downloads.hasActive());const task=m.downloads.status()[0];assert.equal(task.stage,'waiting-directory');assert.deepEqual(await fs.readdir(f.root),[]);assert.deepEqual(await fs.readdir(next),[]);
 m.setConfirm(false);await m.downloads.action(task.id,'install-current');assert.equal(m.downloads.status()[0].stage,'waiting-directory');m.setConfirm(true);await m.downloads.action(task.id,'install-current');assert.equal(m.downloads.status()[0].stage,'ready');assert.deepEqual(await fs.readdir(next),[]);await m.downloads.action(task.id,'retry-install');assert.equal(m.downloads.status()[0].stage,'complete');assert.equal(m.downloads.status()[0].targetRoot,next);assert.deepEqual((await fs.readdir(path.join(next,'角色','安比'))).sort(),['DISABLED_First','DISABLED_Second']);await m.downloads.close();
});
test('metadata failure never installs; reread binding then retry download uses only the owned site link',async()=>{
 const f=await fixture();let fail=true;const m=await manager(f,async()=>fail?new Response('offline',{status:503}):new Response(JSON.stringify(info(pack()))));const item=new Item(pack());m.downloads.accept(item.native(),123,urls);await waitUntil(()=>!m.downloads.hasActive());const task=m.downloads.status()[0];assert.equal(task.stage,'error');assert.deepEqual(await fs.readdir(f.root),[]);fail=false;await m.downloads.action(task.id,'retry-binding');await m.downloads.action(task.id,'retry-download');assert.deepEqual(m.requests,[{modId:123,url:urls[0],gameId:'zzz'}]);await assert.rejects(m.downloads.action('foreign','show-file'),/不存在/);await m.downloads.close();
});
test('cancel aborts metadata work without installing; concurrency limit and shutdown reject new tasks',async()=>{
 const f=await fixture(),m=await manager(f,async(_url,init)=>new Promise((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));const items=[new Item(pack()),new Item(pack()),new Item(pack())];for(const item of items)m.downloads.accept(item.native(),123,urls);assert.throws(()=>m.downloads.accept(new Item(pack()).native(),123,urls),/3 个/);const first=m.downloads.status()[0];await m.downloads.action(first.id,'cancel');await waitUntil(()=>items[0].ended);assert.equal(m.downloads.status()[0].stage,'canceled');await m.downloads.close();assert.equal(m.downloads.status()[1].stage,'interrupted');assert.throws(()=>m.downloads.accept(new Item(pack()).native(),123,urls),/退出/);assert.deepEqual(await fs.readdir(f.root),[]);
});
test('corrupt task records are preserved and interrupted records never auto-install on startup',async()=>{
 const f=await fixture(),m=await manager(f),file=path.join(m.options.cache,'tasks.json');await write(file,'{"broken":');const corrupted=new ModDownloads(m.options);await corrupted.initialize();assert.match(corrupted.error,/原文件已保留/);assert.throws(()=>corrupted.accept(new Item(pack()).native(),123,urls));assert.equal(await fs.readFile(file,'utf8'),'{"broken":');
 const item=new Item(pack());m.downloads.accept(item.native(),123,urls);await item.finish();await waitUntil(()=>!m.downloads.hasActive());await m.downloads.close();const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.tasks[0].status.stage='installing';await write(file,JSON.stringify(saved));const restarted=new ModDownloads(m.options);await restarted.initialize();assert.equal(restarted.status()[0].stage,'interrupted');assert.equal(restarted.hasActive(),false);await restarted.close();const malformed=JSON.parse(await fs.readFile(file,'utf8'));malformed.tasks[0].status.character={broken:true};await write(file,JSON.stringify(malformed));const invalidRole=new ModDownloads(m.options);await invalidRole.initialize();assert.match(invalidRole.error,/角色信息无效/);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).tasks[0].status.character.broken,true);await invalidRole.close();
});
function storedRar(name:string,contents:Buffer){
 const crc=(bytes:Buffer)=>{let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0;};
 const header=(body:Buffer)=>{const result=Buffer.alloc(body.length+2);result.writeUInt16LE(crc(body)&0xffff);body.copy(result,2);return result;};
 const nameBytes=Buffer.from(name);const main=Buffer.alloc(11);main[0]=0x73;main.writeUInt16LE(13,3);const file=Buffer.alloc(30+nameBytes.length);file[0]=0x74;file.writeUInt16LE(0x8000,1);file.writeUInt16LE(file.length+2,3);file.writeUInt32LE(contents.length,5);file.writeUInt32LE(contents.length,9);file[13]=2;file.writeUInt32LE(crc(contents),14);file[22]=20;file[23]=0x30;file.writeUInt16LE(nameBytes.length,24);file.writeUInt32LE(0x20,26);nameBytes.copy(file,30);
 return Buffer.concat([Buffer.from([0x52,0x61,0x72,0x21,0x1a,7,0]),header(main),header(file),contents,header(Buffer.from([0x7b,0,0,7,0]))]);
}
test('real 7z and RAR online imports retain the file binding and install disabled',async()=>{
 const f=await fixture();await write(path.join(f.run,'Seven','main.ini'),'seven');const seven=path.join(f.run,'example.7z');await promisify(execFile)(path7z,['a','-t7z',seven,'Seven'],{cwd:f.run,windowsHide:true});const rar=path.join(f.run,'example.rar');await write(rar,storedRar('Rar/main.ini',Buffer.from('rar')));
 for(const file of [seven,rar]){const bytes=await fs.readFile(file),filename=path.basename(file);const result=await f.mods.installDownload('zzz',file,f.root,bindGameBananaFile(info(bytes,filename),123,urls,filename));assert.equal(result.importedIds.length,1);const mod=result.library.mods.find(mod=>mod.id===result.importedIds[0])!;assert.equal(mod.enabled,false);assert.equal(mod.remote?.fileName,filename);}
});
test('oversized streaming failure records remain readable across restart without installing',async()=>{
 const f=await fixture(),m=await manager(f),item=new Item(pack());m.downloads.accept(item.native(),123,urls);await waitUntil(()=>m.downloads.status()[0]?.stage==='downloading');item.received=2*1024**3+1;item.emit('updated',{},'progressing');await waitUntil(()=>!m.downloads.hasActive());assert.equal(m.downloads.status()[0].stage,'error');await m.downloads.close();const restarted=new ModDownloads(m.options);await restarted.initialize();assert.equal(restarted.error,'');assert.equal(restarted.status()[0].stage,'error');assert.deepEqual(await fs.readdir(f.root),[]);await restarted.close();
});
test('update/quit gate denies new tasks and retries, while shutdown waits for an already started commit result',async()=>{
 const f=await fixture(),m=await manager(f);m.options.canStart=()=>false;assert.throws(()=>m.downloads.accept(new Item(pack()).native(),123,urls),/更新/);m.options.canStart=()=>true;
 const original=m.options.install;let finish!:()=>void;let contentReady=false;const gate=new Promise<void>(resolve=>{finish=resolve;});m.options.install=async(...args)=>{const result=await original(...args);contentReady=true;await gate;return result;};const item=new Item(pack());m.downloads.accept(item.native(),123,urls);await item.finish();await waitUntil(()=>!m.downloads.hasActive());const installation=m.downloads.action(m.downloads.status()[0].id,'retry-install');await waitUntil(()=>m.downloads.status()[0]?.stage==='installing'&&contentReady);
 let closed=false;const closing=m.downloads.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(closed,false);finish();await installation;await closing;assert.equal(m.downloads.status()[0].stage,'complete');assert.equal((await f.mods.scan('zzz')).mods.length,2);
});

test('verified resources remain pending through restart and only an explicit install commits them',async()=>{
 const f=await fixture(),m=await manager(f),item=new Item(pack());m.downloads.accept(item.native(),123,urls);await item.finish();await waitUntil(()=>!m.downloads.hasActive());const id=m.downloads.status()[0].id;
 assert.equal(m.downloads.status()[0].stage,'ready');assert.equal(m.downloads.status()[0].character,'安比');assert.deepEqual(await fs.readdir(f.root),[]);await m.downloads.close();
 const restarted=new ModDownloads(m.options);await restarted.initialize();assert.equal(restarted.status()[0].stage,'ready');assert.deepEqual(await fs.readdir(f.root),[]);
 const plan=await restarted.installPlan(id);assert.ok(plan.items.every(row=>row.folder==='角色/安比'));assert.deepEqual(await fs.readdir(f.root),[]);
 await restarted.action(id,'retry-install');assert.equal(restarted.status()[0].stage,'complete');assert.ok((await f.mods.scan('zzz')).mods.every(mod=>!mod.enabled&&mod.relativePath.startsWith('角色'+path.sep+'安比'+path.sep)));await restarted.close();
});

test('per-entry matching uses existing character folders and keeps ambiguous resources available for manual placement',async()=>{
 const f=await fixture();await fs.mkdir(path.join(f.root,'Anby'));await fs.mkdir(path.join(f.root,'收藏','艾莲'),{recursive:true});
 const bytes=Buffer.from(zipSync({'Anby Outfit/main.ini':strToU8('anby'),'Ellen Dress/main.ini':strToU8('ellen')})),file=path.join(f.run,'example.zip');await write(file,bytes);
 const binding=bindGameBananaFile(info(bytes),123,urls,'example.zip');const plan=await f.mods.downloadInstallPlan('zzz',file,f.root,binding);
 assert.equal(plan.items.find(item=>item.name==='Anby Outfit')?.folder,'Anby');assert.equal(plan.items.find(item=>item.name==='Ellen Dress')?.folder,'收藏/艾莲');assert.deepEqual((await f.mods.scan('zzz')).mods,[]);
 const result=await f.mods.installDownload('zzz',file,f.root,binding);assert.ok(result.library.mods.every(mod=>!mod.enabled));assert.equal(result.library.mods.find(mod=>mod.name==='Ellen Dress')?.metadata.character,'艾莲');
 const unknown=info(pack());unknown._aCategory._sName='Unknown';unknown._sName='Anby Ellen Outfit';await write(file,pack());const unknownPlan=await f.mods.downloadInstallPlan('zzz',file,f.root,bindGameBananaFile(unknown,123,urls,'example.zip'));assert.ok(unknownPlan.items.every(item=>item.character===''&&item.folder==='角色'));
});

test('manual per-item folder choices preserve author/binding and reject outside, malformed and nested Mod destinations',async()=>{
 const f=await fixture(),bytes=pack(),file=path.join(f.run,'example.zip');await write(file,bytes);const binding=bindGameBananaFile(info(bytes),123,urls,'example.zip');
 for(const folder of ['../outside',path.join(f.run,'outside'),'角色/../outside','CON','Textures','角色/.hidden'])await assert.rejects(f.mods.installDownload('zzz',file,f.root,binding,[{entryPath:'First',folder},{entryPath:'Second',folder:''}]));
 await assert.rejects(f.mods.installDownload('zzz',file,f.root,binding,[{entryPath:'foreign',folder:''},{entryPath:'Second',folder:''}]),/不匹配/);assert.deepEqual(await fs.readdir(f.root),[]);
 const result=await f.mods.installDownload('zzz',file,f.root,binding,[{entryPath:'First',folder:'收藏/艾莲'},{entryPath:'Second',folder:''}]);assert.deepEqual(result.errors,[]);assert.ok(result.library.mods.every(mod=>!mod.enabled&&mod.metadata.author==='站点作者'&&mod.remote?.fileId===456));
 assert.equal(result.library.mods.find(mod=>mod.name==='First')?.metadata.character,'艾莲');assert.equal(result.library.mods.find(mod=>mod.name==='Second')?.relativePath,'DISABLED_Second');
 await assert.rejects(f.mods.installDownload('zzz',file,f.root,binding,[{entryPath:'First',folder:'DISABLED_Second/inside'},{entryPath:'Second',folder:''}]),/另一个 Mod/);
});

test('cached resources are reverified at manual install time and metadata reread never installs',async()=>{
 const f=await fixture(),m=await manager(f),item=new Item(pack());m.downloads.accept(item.native(),123,urls);await item.finish();await waitUntil(()=>!m.downloads.hasActive());const id=m.downloads.status()[0].id;
 await m.downloads.action(id,'retry-binding');assert.equal(m.downloads.status()[0].stage,'ready');assert.deepEqual(await fs.readdir(f.root),[]);
 await write(item.file,Buffer.alloc(pack().length));await m.downloads.action(id,'retry-install');assert.equal(m.downloads.status()[0].stage,'error');assert.match(m.downloads.status()[0].message,/校验失败/);assert.deepEqual(await fs.readdir(f.root),[]);await m.downloads.close();
});
test('F01 partial import receipt persists exact download status across restart without undefined optional fields',async()=>{
 const f=await fixture(),m=await manager(f),item=new Item(pack());m.downloads.accept(item.native(),123,urls);await item.finish();await waitUntil(()=>!m.downloads.hasActive());const task=m.downloads.status()[0],source=m.downloads.importSource(task.id),preview=await f.mods.imports.prepareDownload('zzz',source),choices=preview.items.map((row,index)=>({...row,selected:index===0})),plan=await f.mods.imports.revise('zzz',preview.sessionId,choices),result=await (async()=>{await m.downloads.beginImport(task.id);assert.equal(m.downloads.status()[0].stage,'installing');assert.equal(m.downloads.hasActive(),true);assert.throws(()=>m.downloads.importSource(task.id),/准备完成/);return f.mods.imports.commit('zzz',plan.token,false);})();await m.downloads.recordImport(task.id,result);const before=m.downloads.status();assert.equal(before[0].stage,'partial');assert.equal(before[0].importedIds.length,1);assert.ok(!Object.hasOwn(before[0].items[0],'error'));assert.ok(!Object.hasOwn(before[0].items[0],'existing'));await m.downloads.close();const restarted=await manager(f);assert.deepEqual(restarted.downloads.status(),before);await restarted.downloads.beginImport(task.id);await restarted.downloads.close();const interrupted=await manager(f);assert.equal(interrupted.downloads.status()[0].stage,'interrupted');assert.equal((await f.mods.scan('zzz')).mods.length,1);await interrupted.downloads.close();
});
test('F01 skipping every entry stays ready and a stop before the first entry is interrupted rather than failed',async()=>{
 const f=await fixture(),m=await manager(f),item=new Item(pack());m.downloads.accept(item.native(),123,urls);await item.finish();await waitUntil(()=>!m.downloads.hasActive());const task=m.downloads.status()[0],source=m.downloads.importSource(task.id),p=await f.mods.imports.prepareDownload('zzz',source),skipped=await f.mods.imports.revise('zzz',p.sessionId,p.items.map(row=>({...row,selected:false}))),result=await f.mods.imports.commit('zzz',skipped.token,false);await m.downloads.recordImport(task.id,result);assert.equal(m.downloads.status()[0].stage,'ready');assert.equal(result.importedIds.length,0);
 const next=await f.mods.imports.prepareDownload('zzz',m.downloads.importSource(task.id)),scan=f.mods.scan.bind(f.mods);let stopped=false;f.mods.scan=async(...args)=>{const library=await scan(...args);if(!stopped&&args[1]!==true){stopped=true;await f.mods.imports.discard('zzz',next.sessionId);}return library;};await m.downloads.beginImport(task.id);try{const receipt=await f.mods.imports.commit('zzz',next.token,false);assert.equal(receipt.canceled,true);assert.equal(receipt.importedIds.length,0);await m.downloads.recordImport(task.id,receipt);assert.equal(m.downloads.status()[0].stage,'interrupted');}finally{f.mods.scan=scan;await m.downloads.close();}
});

test('Endfield binding validates game identity and maps its own character namespace',()=>{
 const json=endfieldInfo(pack()),binding=bindGameBananaFile(json,123,urls,'example.zip','endfield');
 assert.equal(binding.gameId,'endfield');assert.equal(binding.metadata.character,'佩丽卡');assert.equal(binding.metadata.category,'角色');
 assert.throws(()=>bindGameBananaFile(json,123,urls,'example.zip','zzz'),/绝区零/);
 assert.throws(()=>bindGameBananaFile(info(pack()),123,urls,'example.zip','endfield'),/终末地/);
 assert.throws(()=>readDownloadBinding(binding,'zzz'),/游戏不匹配/);
 const legacy={...bindGameBananaFile(info(pack()),123,urls,'example.zip')} as Partial<ReturnType<typeof bindGameBananaFile>>;delete legacy.gameId;
 assert.equal(readDownloadBinding(legacy,'zzz').gameId,'zzz');assert.throws(()=>readDownloadBinding(legacy,'endfield'),/游戏不匹配/);
});
test('Endfield multi-Mod plans/install/manual folders/recovery share the same validated disabled import flow',async()=>{
 const f=await fixture(),root=f.settings.games.endfield.modsDirectory;
 await fs.mkdir(path.join(root,'收藏','Perlica'),{recursive:true});await fs.mkdir(path.join(root,'角色','莱万汀'),{recursive:true});
 const bytes=Buffer.from(zipSync({'Perlica Dress/main.ini':strToU8('perlica'),'Laevatain Outfit/main.ini':strToU8('laevatain')})),file=path.join(f.run,'example.zip');await write(file,bytes);
 const binding=bindGameBananaFile(endfieldInfo(bytes),123,urls,'example.zip','endfield');const plan=await f.mods.downloadInstallPlan('endfield',file,root,binding);
 assert.equal(plan.items.find(item=>item.name==='Perlica Dress')?.folder,'收藏/Perlica');assert.equal(plan.items.find(item=>item.name==='Laevatain Outfit')?.folder,'角色/莱万汀');
 const result=await f.mods.installDownload('endfield',file,root,binding,plan.items.map(item=>({...item,folder:item.name==='Laevatain Outfit'?'手动/莱万汀':item.folder})));
 assert.equal(result.importedIds.length,2);assert.deepEqual(result.errors,[]);assert.ok(result.library.mods.every(mod=>!mod.enabled&&mod.provenance.verification==='unverified'&&mod.remote?.fileId===456));
 const perlica=result.library.mods.find(mod=>mod.metadata.character==='佩丽卡')!;assert.ok(perlica.relativePath.includes('Perlica'));assert.equal(result.library.mods.find(mod=>mod.name==='Laevatain Outfit')?.metadata.character,'莱万汀');assert.deepEqual((await f.mods.scan('zzz')).mods,[]);
 await f.mods.operate('endfield',perlica.id,{kind:'rename',name:'KeepPerlica'});const again=await f.mods.installDownload('endfield',file,root,binding);assert.equal(again.importedIds.length,0);assert.equal(again.items.filter(item=>item.existing).length,2);
 const backup=(await f.business.createBackup('endfield','Endfield website'))[0];const original=again.library.mods.find(mod=>mod.id===perlica.id)!.remote;const replacement=path.join(f.run,'replacement');await write(path.join(replacement,'main.ini'),'replacement');assert.equal((await f.mods.replace('endfield',perlica.id,replacement)).mods.find(mod=>mod.id===perlica.id)?.remote,undefined);
 const restored=await f.business.restore('endfield',backup.id);assert.deepEqual(restored.mods.find(mod=>mod.id===perlica.id)?.remote,original);assert.deepEqual((await f.mods.scan('zzz')).mods,[]);
});
test('Endfield task uses its saved directory and pinned game across other-game edits, retries and restarts',async()=>{
 const f=await fixture(),m=await manager(f,async()=>new Response(JSON.stringify(endfieldInfo(pack())))),item=new Item(pack());m.downloads.accept(item.native(),123,urls,'endfield');await item.finish();await waitUntil(()=>!m.downloads.hasActive());
 let task=m.downloads.status()[0];assert.equal(task.gameId,'endfield');assert.equal(task.targetRoot,f.settings.games.endfield.modsDirectory);assert.equal(task.stage,'ready');
 await f.store.save({...f.settings,selectedGame:'zzz',games:{...f.settings.games,zzz:{...f.settings.games.zzz,modsDirectory:path.join(f.run,'OtherZZZ')}}});await m.downloads.action(task.id,'retry-binding');assert.equal(m.downloads.status()[0].stage,'ready');
 await m.downloads.action(task.id,'retry-download');assert.deepEqual(m.requests,[{modId:123,url:urls[0],gameId:'endfield'}]);
 const next=path.join(f.run,'NewEndfield');await fs.mkdir(next);const saved=await f.store.read();await f.store.save({...saved,games:{...saved.games,endfield:{...saved.games.endfield,modsDirectory:next}}});await m.downloads.action(task.id,'retry-install');assert.equal(m.downloads.status()[0].stage,'waiting-directory');assert.deepEqual(await fs.readdir(next),[]);
 m.setConfirm(false);await m.downloads.action(task.id,'install-current');assert.equal(m.downloads.status()[0].stage,'waiting-directory');m.setConfirm(true);await m.downloads.action(task.id,'install-current');assert.equal(m.downloads.status()[0].stage,'ready');await m.downloads.action(task.id,'retry-install');assert.equal(m.downloads.status()[0].stage,'complete');assert.deepEqual(await fs.readdir(f.settings.games.endfield.modsDirectory),[]);
 await m.downloads.close();const restarted=new ModDownloads(m.options);await restarted.initialize();task=restarted.status()[0];assert.equal(task.gameId,'endfield');assert.equal(task.targetRoot,next);assert.equal(task.stage,'complete');assert.ok((await f.mods.scan('endfield')).mods.every(mod=>!mod.enabled&&mod.metadata.character==='佩丽卡'));await restarted.close();
});
test('Endfield rejects dangerous archives and checksum tampering without touching either game',async()=>{
 const f=await fixture(),root=f.settings.games.endfield.modsDirectory,file=path.join(f.run,'example.zip');
 for(const bytes of [Buffer.from(zipSync({'../outside.ini':strToU8('unsafe')})),Buffer.from(zipSync({'readme.txt':strToU8('no ini')}))]){await write(file,bytes);await assert.rejects(f.mods.installDownload('endfield',file,root,bindGameBananaFile(endfieldInfo(bytes),123,urls,'example.zip','endfield')));}
 const bytes=pack();await write(file,bytes);const binding=bindGameBananaFile(endfieldInfo(bytes),123,urls,'example.zip','endfield');const bad=Buffer.from(bytes);bad[30]^=1;await write(file,bad);await assert.rejects(f.mods.installDownload('endfield',file,root,binding),/校验失败/);assert.deepEqual(await fs.readdir(root),[]);assert.deepEqual((await f.mods.scan('zzz')).mods,[]);
});
