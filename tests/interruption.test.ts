import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {ModService} from '../src/main/mods';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {BusinessService} from '../src/main/business';
import {FileOperations} from '../src/main/file-operations';
import {IniService} from '../src/main/ini';
import type {GameId} from '../src/shared/contracts';

async function write(file:string,text:string){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
async function fixture(){const parent=path.resolve('.run-data/interruption-tests');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-')),data=path.join(run,'data'),store=new SettingsStore(data),settings=defaultSettings();for(const game of ['zzz','endfield'] as const){settings.games[game].modsDirectory=path.join(run,game,'Mods');await write(path.join(settings.games[game].modsDirectory,'Alpha','main.ini'),'original '+game);}await store.save(settings);await write(path.join(run,'Incoming','main.ini'),'replacement');await write(path.join(run,'Incoming','Textures','large.dds'),'texture');const mods=new ModService(data,async game=>(await store.read()).games[game]),business=new BusinessService(data,mods,store);await mods.scan('zzz');await mods.scan('endfield');return {run,data,store,settings,mods,business,ops:new FileOperations(data)};}
async function terminate(f:Awaited<ReturnType<typeof fixture>>,kind:string,point:string,game:GameId='zzz',backupId=''){
 const worker=fork(path.resolve('tests/helpers/interruption-worker.ts'),[f.run,kind,point,game,backupId],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';worker.stderr?.on('data',bytes=>{stderr+=bytes;});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{worker.kill();reject(new Error('Interruption worker timed out: '+stderr));},15000);worker.once('error',error=>{clearTimeout(timer);reject(error);});worker.on('message',(message:any)=>{if(message.paused){clearTimeout(timer);resolve();}else if(message.error||message.unexpectedCompletion){clearTimeout(timer);reject(new Error(message.error||'Worker completed before checkpoint'));}});worker.once('exit',code=>{if(code!==null){clearTimeout(timer);reject(new Error('Worker exited '+code+': '+stderr));}});});
 await new Promise<void>(resolve=>{worker.once('exit',()=>resolve());worker.kill('SIGKILL');});
 const pending=(await f.ops.list(game)).find(item=>item.kind==='interrupted');assert.ok(pending,'terminated operation must remain recorded');const logs=(await fs.readFile(path.join(f.data,'logs','operations.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.ok(logs.some(row=>row.phase==='start'));assert.ok(logs.some(row=>row.phase==='reference'&&row.reference.kind==='file-operation'&&row.reference.id===pending.id));assert.ok(!logs.some(row=>row.phase==='finish'));return pending;
}

test('disk-full staging never exposes a partial import and leaves existing files/metadata intact',async()=>{
 const f=await fixture(),before=await fs.readFile(path.join(f.data,'library-zzz.json'));const copy=fs.copyFile;
 fs.copyFile=async(from,to,mode)=>{if(String(to).includes('.kmm-operation-')&&String(from).endsWith('large.dds'))throw Object.assign(new Error('fixture disk full'),{code:'ENOSPC'});return copy(from,to,mode);};let result;
 try{result=await f.mods.import('zzz',[path.join(f.run,'Incoming')]);}finally{fs.copyFile=copy;}
 assert.equal(result.importedIds.length,0);assert.match(result.errors.join(' '),/disk full/);await assert.rejects(fs.stat(path.join(f.settings.games.zzz.modsDirectory,'Incoming')),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(f.settings.games.zzz.modsDirectory,'Alpha','main.ini'),'utf8'),'original zzz');assert.deepEqual(await fs.readFile(path.join(f.data,'library-zzz.json')),before);assert.deepEqual(await f.ops.list('zzz'),[]);
});
test('occupied original directory aborts replacement without removing content or identity',async()=>{
 const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0],rename=fs.rename;
 fs.rename=async(from,to)=>{if(String(to).endsWith(path.sep+'original'))throw Object.assign(new Error('fixture file occupied'),{code:'EBUSY'});return rename(from,to);};try{await assert.rejects(f.mods.replace('zzz',mod.id,path.join(f.run,'Incoming')),/occupied/);}finally{fs.rename=rename;}
 assert.equal((await f.mods.scan('zzz')).mods[0].id,mod.id);assert.equal(await fs.readFile(path.join(f.settings.games.zzz.modsDirectory,'Alpha','main.ini'),'utf8'),'original zzz');assert.deepEqual(await f.ops.list('zzz'),[]);
});
test('disk-full while creating an empty ownership marker leaves no blocking operation',async()=>{
 const f=await fixture(),before=await fs.readFile(path.join(f.data,'library-zzz.json')),writeFile=fs.writeFile;
 fs.writeFile=async(file,...args)=>{if(String(file).endsWith(path.sep+'owner'))throw Object.assign(new Error('fixture marker disk full'),{code:'ENOSPC'});return (writeFile as any)(file,...args);};let result;try{result=await f.mods.import('zzz',[path.join(f.run,'Incoming')]);}finally{fs.writeFile=writeFile;}
 assert.equal(result.importedIds.length,0);assert.match(result.errors.join(' '),/disk full/);assert.deepEqual(await f.ops.list('zzz'),[]);assert.deepEqual(await fs.readFile(path.join(f.data,'library-zzz.json')),before);
});
test('failed registry commit rolls files back and preserves submitted content for inspection',async()=>{
 const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0],before=await fs.readFile(path.join(f.data,'library-zzz.json')),rename=fs.rename;
 fs.rename=async(from,to)=>{if(String(to)===path.join(f.data,'library-zzz.json'))throw Object.assign(new Error('fixture metadata disk full'),{code:'ENOSPC'});return rename(from,to);};try{await assert.rejects(f.mods.replace('zzz',mod.id,path.join(f.run,'Incoming')),/disk full/);}finally{fs.rename=rename;}
 assert.equal(await fs.readFile(path.join(f.settings.games.zzz.modsDirectory,'Alpha','main.ini'),'utf8'),'original zzz');assert.deepEqual(await fs.readFile(path.join(f.data,'library-zzz.json')),before);assert.equal((await f.mods.scan('zzz')).mods[0].id,mod.id);const retained=(await f.ops.list('zzz')).find(item=>item.kind==='legacy')!;assert.equal(await fs.readFile(path.join(retained.manualLocation!,'main.ini'),'utf8'),'replacement');assert.match(retained.manualLocation!,/DISABLED_\.kmm-operation-/);assert.equal((await f.mods.scan('zzz')).mods.length,1);
});
test('actual process termination during staging/old move/new apply/metadata commit restores both games and stable IDs',async()=>{
 for(const game of ['zzz','endfield'] as const)for(const point of ['staging','old-moved','new-applied','metadata-saved']){const f=await fixture(),root=f.settings.games[game].modsDirectory,mod=(await f.mods.scan(game)).mods[0],before=await fs.readFile(path.join(f.data,'library-'+game+'.json')),other=game==='zzz'?'endfield':'zzz';const pending=await terminate(f,'replace',point,game);await assert.rejects(f.mods.scan(game),/未完成文件操作/);assert.equal((await f.mods.scan(other)).mods.length,1);await f.business.restore(game,pending.id);assert.equal(await fs.readFile(path.join(root,'Alpha','main.ini'),'utf8'),'original '+game);assert.deepEqual(await fs.readFile(path.join(f.data,'library-'+game+'.json')),before);assert.equal((await f.mods.scan(game)).mods[0].id,mod.id);assert.ok(!(await f.ops.list(game)).some(item=>item.kind==='interrupted'));}
});
test('actual termination during rename/delete/import keeps their before-state recoverable',async()=>{
 for(const [kind,point]of [['move','move-applied'],['delete','old-moved'],['import','new-applied']]){const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0],pending=await terminate(f,kind,point);await f.business.restore('zzz',pending.id);const library=await f.mods.scan('zzz');assert.equal(library.mods.length,1);assert.equal(library.mods[0].id,mod.id);assert.equal(library.mods[0].enabled,true);assert.equal(library.mods[0].relativePath,'Alpha');}
});
test('terminated full snapshot restores the current root even when it was temporarily absent, preserving other-game settings',async()=>{
 const f=await fixture(),backup=(await f.business.createBackup('zzz','original snapshot')).find(item=>item.kind==='snapshot')!;await write(path.join(f.settings.games.zzz.modsDirectory,'Alpha','main.ini'),'current before restore');const pending=await terminate(f,'snapshot','old-moved','zzz',backup.id);await assert.rejects(fs.stat(f.settings.games.zzz.modsDirectory),{code:'ENOENT'});const current=await f.store.read();await f.store.save({...current,selectedGame:'endfield',games:{...current.games,endfield:{...current.games.endfield,gameDirectory:path.join(f.run,'Other game edited')}}});await f.business.restore('zzz',pending.id);assert.equal(await fs.readFile(path.join(f.settings.games.zzz.modsDirectory,'Alpha','main.ini'),'utf8'),'current before restore');assert.equal((await f.store.read()).selectedGame,'endfield');assert.equal((await f.store.read()).games.endfield.gameDirectory,path.join(f.run,'Other game edited'));
});
test('external replacement of a directory after interruption is never overwritten',async()=>{
 const f=await fixture(),pending=await terminate(f,'replace','new-applied'),root=f.settings.games.zzz.modsDirectory;await fs.rename(path.join(root,'Alpha'),path.join(f.run,'Preserve interrupted content'));await write(path.join(root,'Alpha','important.ini'),'external user content');await assert.rejects(f.business.restore('zzz',pending.id),/身份已变化/);assert.equal(await fs.readFile(path.join(root,'Alpha','important.ini'),'utf8'),'external user content');assert.ok((await f.ops.list('zzz')).some(item=>item.id===pending.id));
});
test('tampered journal paths and changed metadata reject recovery before touching user data',async()=>{
 const f=await fixture(),pending=await terminate(f,'replace','new-applied'),file=path.join(f.data,'pending-operations',pending.id+'.json'),record=JSON.parse(await fs.readFile(file,'utf8')),original=await fs.readFile(file);record.steps[0].work=path.resolve('..');await fs.writeFile(file,JSON.stringify(record));await assert.rejects(f.business.restore('zzz',pending.id),/路径无效/);await fs.writeFile(file,original);const metadataFile=path.join(f.data,'library-zzz.json'),data=JSON.parse(await fs.readFile(metadataFile,'utf8'));data.groups.category.push('External edit');await fs.writeFile(metadataFile,JSON.stringify(data));await assert.rejects(f.business.restore('zzz',pending.id),/元数据已被外部修改/);assert.equal(await fs.readFile(path.join(f.settings.games.zzz.modsDirectory,'Alpha','main.ini'),'utf8'),'replacement');
});
test('atomic INI write fails without truncation and complete backup remains available',async()=>{
 const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0],ini=new IniService(f.mods,f.business.recovery),doc=await ini.read('zzz',mod.id,'main.ini'),writeFile=fs.writeFile;
 fs.writeFile=async(file,...args)=>{if(String(file).endsWith('main.ini.tmp'))throw Object.assign(new Error('fixture INI disk full'),{code:'ENOSPC'});return (writeFile as any)(file,...args);};try{await assert.rejects(ini.save('zzz',mod.id,'main.ini',doc.digest,{kind:'text',text:'new ini'}),/disk full/);}finally{fs.writeFile=writeFile;}
 assert.equal((await ini.read('zzz',mod.id,'main.ini')).text,'original zzz');assert.ok((await f.business.recovery.list('zzz')).some(item=>item.kind==='ini'));
});
