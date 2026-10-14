import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {OperationLog,logOperationReference} from '../src/main/operation-log';
import {ModService} from '../src/main/mods';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {BusinessService} from '../src/main/business';

async function write(file:string,text:string){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
async function fixture(){const parent=path.resolve('.run-data/operation-log-tests');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-')),data=path.join(run,'data'),store=new SettingsStore(data),settings=defaultSettings();for(const game of ['zzz','endfield'] as const){settings.games[game].modsDirectory=path.join(run,game,'Mods');await write(path.join(settings.games[game].modsDirectory,'Alpha','main.ini'),'original '+game);}await store.save(settings);const mods=new ModService(data,async game=>(await store.read()).games[game]),business=new BusinessService(data,mods,store);await write(path.join(run,'Incoming','main.ini'),'replacement');return {run,data,store,settings,mods,business,log:new OperationLog(data),file:path.join(data,'logs','operations.jsonl')};}
async function records(file:string){return (await fs.readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));}

test('real replacement and preset operations log identities and completed backup references without private values',async()=>{
 const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0],secret='LOG_PRIVATE_TOKEN';
 await f.log.run('mods:operate',['zzz',mod.id,{kind:'provenance',fields:{sourceUrl:'https://example.com/mod?token='+secret,version:secret,gameVersion:secret,verification:'unverified'}}],()=>f.mods.operate('zzz',mod.id,{kind:'provenance',fields:{sourceUrl:'https://example.com/mod?token='+secret,version:secret,gameVersion:secret,verification:'unverified'}}));
 await f.log.run('mods:replace',['zzz',mod.id,'folder'],()=>f.mods.replace('zzz',mod.id,path.join(f.run,'Incoming')));
 const presets=await f.log.run('presets:save',['zzz',null,'Test preset',null],()=>f.business.savePreset('zzz',null,'Test preset',null));
 await f.log.run('presets:add-members',['zzz',presets[0].id,[mod.id]],()=>f.business.addModsToPreset('zzz',presets[0].id,[mod.id]));
 await f.log.run('presets:apply',['zzz',presets[0].id],()=>f.business.applyPreset('zzz',presets[0].id));
 const rows=await records(f.file),finished=rows.filter(row=>row.phase==='finish');assert.equal(finished.length,5);assert.ok(finished.every(row=>row.result.status==='succeeded'));
 const replacement=finished.find(row=>row.action==='mods:replace'),refs=rows.filter(row=>row.id===replacement.id&&row.phase==='reference');assert.ok(refs.some(row=>row.reference.kind==='file-operation'));const backup=refs.find(row=>row.reference.kind==='backup');assert.ok(backup);assert.equal(JSON.parse(await fs.readFile(path.join(f.data,'removed','zzz',backup.reference.id+'.json'),'utf8')).modId,mod.id);assert.ok(replacement.referenceIds.includes(backup.reference.id));
 assert.equal(finished.find(row=>row.action==='presets:save').result.savedId,presets[0].id);assert.deepEqual(finished.find(row=>row.action==='presets:add-members').targetIds,[presets[0].id,mod.id]);
 const text=await fs.readFile(f.file,'utf8');assert.ok(!text.includes(secret));assert.ok(!text.includes('https://'));assert.ok(!text.includes(f.run.replace(/\\/g,'\\\\')));assert.equal((await f.mods.scan('zzz')).mods[0].id,mod.id);
});
test('logs preserve partial, canceled, explicit-choice and thrown results; reads remain unlogged',async()=>{
 const f=await fixture(),modId=randomUUID();await f.log.run('mods:scan',['zzz'],async()=>true);await assert.rejects(fs.stat(path.dirname(f.file)),{code:'ENOENT'});
 for(const [value,status]of [[{items:[{id:modId,ok:true},{id:randomUUID(),ok:false,error:'同名冲突 https://secret.invalid?cookie=PRIVATE'}]},'partial'],[{canceled:true},'canceled'],[null,'canceled'],[{conflicts:[{}]},'awaiting-choice'],[{importedIds:[],errors:['ENOSPC PRIVATE']},'failed']] as const){assert.equal(await f.log.run('mods:batch',['zzz',[modId],{kind:'toggle',enabled:true}],async()=>value),value);const last=(await records(f.file)).at(-1);assert.equal(last.result.status,status);}
 const error=Object.assign(new Error('ENOSPC PRIVATE https://secret.invalid'),{code:'ENOSPC'});await assert.rejects(f.log.run('mods:delete',['endfield',modId],async()=>{throw error;}),failure=>failure===error);const rows=await records(f.file);assert.equal(rows.at(-1).gameId,'endfield');assert.deepEqual(rows.at(-1).result.failureCategories,['disk-full']);assert.ok(!(await fs.readFile(f.file,'utf8')).includes('PRIVATE'));
});
test('concurrent logs rotate within the fixed size and retain their own operation references',async()=>{
 const f=await fixture(),limit=2*1024**2;await write(f.file,'x'.repeat(limit-1)+'\n');for(let index=1;index<=3;index++)await write(f.file+'.'+index,'archive '+index);
 const refs=new Map<string,string>();await Promise.all(Array.from({length:60},async(_,index)=>{const target=randomUUID(),reference=randomUUID(),game=index%2?'zzz':'endfield';refs.set(target,reference);await f.log.run('mods:operate',[game,target,{kind:'toggle',enabled:false}],async()=>{await logOperationReference(f.data,game,'file-operation',reference);await logOperationReference(f.data,game==='zzz'?'endfield':'zzz','backup',randomUUID());return {};},index%2?'main':'floating');}));await f.log.flush();
 const rows=await records(f.file);assert.equal(rows.length,180);for(const entry of rows.filter(row=>row.phase==='finish')){assert.equal(entry.result.status,'succeeded');assert.deepEqual(entry.referenceIds,[refs.get(entry.targetIds[0])]);assert.equal(rows.find(row=>row.id===entry.id&&row.phase==='reference').reference.id,entry.referenceIds[0]);}
 assert.equal((await fs.stat(f.file+'.1')).size,limit);assert.equal(await fs.readFile(f.file+'.2','utf8'),'archive 1');assert.equal(await fs.readFile(f.file+'.3','utf8'),'archive 2');assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(),['operations.jsonl','operations.jsonl.1','operations.jsonl.2','operations.jsonl.3']);for(let index=0;index<=3;index++)assert.ok((await fs.stat(f.file+(index?'.'+index:''))).size<=limit);
 const ids=Array.from({length:5000},()=>randomUUID());await f.log.run('mods:batch',['zzz',ids,{kind:'toggle',enabled:true}],async()=>({importedIds:ids,errors:[]}));const end=(await records(f.file)).at(-1);assert.equal(end.targetCount,5000);assert.equal(end.targetIds.length,40);assert.equal(end.result.imported,5000);assert.equal(end.result.importedIds.length,40);assert.ok(Buffer.byteLength(JSON.stringify(end))<16*1024);
});
test('an unwritable log never changes the result or rollback of a real Mod operation',async()=>{
 const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0],append=fs.appendFile,warn=console.warn,warnings:string[]=[];
 fs.appendFile=async(file,...args)=>{if(String(file)===f.file)throw Object.assign(new Error('fixture log disk full'),{code:'ENOSPC'});return (append as any)(file,...args);};console.warn=(message:string)=>{warnings.push(message);};
 try{const result=await f.log.run('mods:replace',['zzz',mod.id,'folder'],()=>f.mods.replace('zzz',mod.id,path.join(f.run,'Incoming')));assert.equal(result.mods[0].id,mod.id);await f.log.flush();}finally{fs.appendFile=append;console.warn=warn;}
 assert.equal(warnings.length,1);assert.equal(await fs.readFile(path.join(f.settings.games.zzz.modsDirectory,'Alpha','main.ini'),'utf8'),'replacement');assert.ok((await f.business.recovery.list('zzz')).some(item=>item.kind==='mod-replace'));
});
test('a partially written line never merges with or hides the next complete log entry',async()=>{
 const f=await fixture(),append=fs.appendFile,warn=console.warn;let injected=false;
 fs.appendFile=async(file,bytes,...args)=>{if(String(file)===f.file&&!injected){injected=true;await (append as any)(file,String(bytes).slice(0,13),...args);throw Object.assign(new Error('fixture partial log disk full'),{code:'ENOSPC'});}return (append as any)(file,bytes,...args);};console.warn=()=>{};
 try{assert.equal(await f.log.run('mods:delete',['zzz',randomUUID()],async()=>null),null);}finally{fs.appendFile=append;console.warn=warn;}
 await f.log.run('mods:delete',['endfield',randomUUID()],async()=>null);const lines=(await fs.readFile(f.file,'utf8')).trim().split('\n');assert.throws(()=>JSON.parse(lines[0]));const valid=lines.slice(1).map(line=>JSON.parse(line));assert.equal(valid.length,3);assert.equal(valid[0].result.status,'canceled');assert.equal(valid.at(-1).gameId,'endfield');assert.equal(valid.at(-1).result.status,'canceled');
});
