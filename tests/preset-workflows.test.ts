import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {zipSync} from 'fflate';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {ModService} from '../src/main/mods';
import {BusinessService} from '../src/main/business';
import {PresetManifests} from '../src/main/preset-manifests';
import {FileOperations} from '../src/main/file-operations';
import {hashModTree,inspectModTree} from '../src/main/content-fingerprint';
import {encodePresetPackage,readPresetPackage,parseUniqueJson,readPortablePreset} from '../src/main/preset-package';
import {DependencyError} from '../src/main/dependencies';
import {sha} from '../src/main/inspection-files';
import {bindGameBananaFile} from '../src/main/gamebanana';
import {ReadJobs} from '../src/main/read-jobs';
import type {GameId,ModRequirements} from '../src/shared/contracts';
import type {ManifestChoice} from '../src/shared/preset-workflows';

const signal=()=>new AbortController().signal,progress=(_message:string)=>{};
async function write(file:string,bytes:string|Buffer){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
async function fixture(){
 const parent=path.resolve('.run-data/preset-workflow-tests');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-')),data=path.join(run,'data'),store=new SettingsStore(data),settings=defaultSettings();
 for(const game of ['zzz','endfield'] as const){settings.games[game]={modsDirectory:path.join(run,game,'Mods'),xxmiRoot:path.join(run,game,'XXMI'),gameDirectory:''};for(const name of ['Provider','Consumer','Other'])await write(path.join(settings.games[game].modsDirectory,'DISABLED_'+name,'main.ini'),'[Constants]\n'+name+' = 1\n');}
 await store.save(settings);const mods=new ModService(data,async game=>(await store.read()).games[game]),business=new BusinessService(data,mods,store),manifests=new PresetManifests(data,mods,business,store);for(const game of ['zzz','endfield'] as const)await mods.scan(game);return {run,data,settings,store,mods,business,manifests};
}
const requirements=(mods:ModRequirements['mods']=[]):ModRequirements=>({origin:'manual',mods,components:[]});
test('read jobs never return another preset request or an already canceling job',async()=>{
 const jobs=new ReadJobs(async()=>''),paths={modsDirectory:'unused',xxmiRoot:'',gameDirectory:''};let release!:()=>void;const work=async()=>{await new Promise<void>(resolve=>{release=resolve;});return undefined;};const first=await jobs.start('preset-preview','zzz',paths,work,undefined,'A');
 assert.equal((await jobs.start('preset-preview','zzz',paths,work,undefined,'A')).id,first.id);await assert.rejects(jobs.start('preset-preview','zzz',paths,work,undefined,'B'),/同类/);jobs.cancel(first.id);await assert.rejects(jobs.start('preset-preview','zzz',paths,work,undefined,'A'),/同类/);release();await new Promise(resolve=>setTimeout(resolve,10));assert.equal((await jobs.read(first.id)).stage,'canceled');
});
async function preset(f:Awaited<ReturnType<typeof fixture>>,game:GameId='zzz',names=['Provider','Consumer']){const library=await f.mods.scan(game),members=Object.fromEntries(library.mods.filter(m=>names.includes(m.name)).map(m=>[m.id,true]));return (await f.business.savePreset(game,null,'组合',members)).at(-1)!;}
async function exported(f:Awaited<ReturnType<typeof fixture>>,game:GameId='zzz',includeProfile=false,id?:string){const p=id||(await preset(f,game)).id,preview=await f.manifests.prepareExport(game,p,includeProfile,signal(),progress),file=path.join(f.run,includeProfile?'share.kmm-profile.zip':'share.kmm-preset.json');await f.manifests.export(game,preview.token,file);return {file,preview};}

test('ordinary preset preview is read-only; commit changes flags as a group and keeps unrelated members/INI/active profile',async()=>{
 for(const game of ['zzz','endfield'] as const){const f=await fixture(),p=await preset(f,game),before=await fs.readFile(path.join(f.data,'library-'+game+'.json')),ini=await fs.readFile(path.join(f.settings.games[game].modsDirectory,'DISABLED_Provider','main.ini'));
  const plan=await f.business.presetPlanner.prepare(game,p.id);assert.equal(plan.canApply,true);assert.equal(plan.changes,2);assert.deepEqual(await fs.readFile(path.join(f.data,'library-'+game+'.json')),before);assert.equal((await f.mods.scan(game)).mods.filter(m=>m.enabled).length,0);
  const result=await f.business.presetPlanner.commit(game,plan.token);assert.equal(result.applied,2);assert.equal(result.library.mods.find(m=>m.name==='Other')!.enabled,false);assert.deepEqual(await fs.readFile(path.join(f.settings.games[game].modsDirectory,'Provider','main.ini')),ini);assert.equal((await f.mods.context(game)).data.activeProfile,undefined);await assert.rejects(f.business.presetPlanner.commit(game,plan.token),/过期/);
  const same=await f.business.presetPlanner.prepare(game,p.id);assert.equal(same.changes,0);assert.equal((await f.business.presetPlanner.commit(game,same.token)).unchanged,2);
 }
});
test('preview requires explicit exclusive choices, shows outside peers and blocks dependency contradictions',async()=>{
 const f=await fixture(),library=await f.mods.scan('zzz'),a=library.mods.find(m=>m.name==='Provider')!,b=library.mods.find(m=>m.name==='Consumer')!,other=library.mods.find(m=>m.name==='Other')!;
 await f.mods.saveExclusiveGroup('zzz',null,'外观',[a.id,b.id]);const group=(await f.mods.scan('zzz')).exclusiveGroups[0],p=await preset(f);
 const conflict=await f.business.presetPlanner.prepare('zzz',p.id);assert.equal(conflict.conflicts.length,1);await assert.rejects(f.business.presetPlanner.commit('zzz',conflict.token),/处理/);
 const chosen=await f.business.presetPlanner.prepare('zzz',p.id,{[group.id]:a.id});assert.equal(chosen.canApply,true);await f.business.presetPlanner.commit('zzz',chosen.token);
 const single=(await f.business.savePreset('zzz',null,'切换',{[b.id]:true})).at(-1)!,outside=await f.business.presetPlanner.prepare('zzz',single.id);assert.ok(outside.rows.some(row=>row.id===a.id&&row.outside&&row.status==='disable'));assert.ok(!outside.rows.some(row=>row.id===other.id));
 await f.mods.operate('zzz',b.id,{kind:'requirements',value:requirements([{modId:a.id}])});const blocked=await f.business.presetPlanner.prepare('zzz',single.id);assert.equal(blocked.canApply,false);assert.ok(blocked.blockers.some(text=>text.includes('依赖')));
});
test('read-only preview tolerates new nonmembers without inventing content revisions or writing the index',async()=>{
 const f=await fixture(),p=await preset(f),before=await fs.readFile(path.join(f.data,'library-zzz.json'));await write(path.join(f.settings.games.zzz.modsDirectory,'DISABLED_New/main.ini'),'[Constants]\nnew=1');
 const plan=await f.business.presetPlanner.prepare('zzz',p.id);assert.equal(plan.canApply,true);assert.deepEqual(await fs.readFile(path.join(f.data,'library-zzz.json')),before);const unindexed=(await f.mods.readonlyScan('zzz')).mods.find(mod=>mod.name==='New')!;assert.match(unindexed.id,/^unindexed:/);assert.equal(unindexed.contentRevision,undefined);await f.business.presetPlanner.commit('zzz',plan.token);assert.equal((await f.mods.scan('zzz')).mods.find(mod=>mod.name==='New')!.enabled,false);
});
test('dependency cascade and warnings remain retryable until confirmed; excluded missing names stay visible',async()=>{
 const f=await fixture(),library=await f.mods.scan('zzz'),provider=library.mods.find(m=>m.name==='Provider')!,consumer=library.mods.find(m=>m.name==='Consumer')!;
 await f.mods.operate('zzz',consumer.id,{kind:'requirements',value:requirements([{modId:provider.id}])});await f.mods.batch('zzz',[provider.id,consumer.id],{kind:'toggle',enabled:true});
 const p=(await f.business.savePreset('zzz',null,'停用前置',{[provider.id]:false})).at(-1)!,plan=await f.business.presetPlanner.prepare('zzz',p.id);
 assert.ok(plan.rows.some(row=>row.id===consumer.id&&row.outside&&row.status==='disable'));await assert.rejects(f.business.presetPlanner.commit('zzz',plan.token),DependencyError);assert.equal((await f.mods.scan('zzz')).mods.filter(m=>m.enabled).length,2);
 const result=await f.business.presetPlanner.commit('zzz',plan.token,{token:plan.dependency.token,acceptWarnings:true});assert.equal(result.applied,2);
 await f.mods.delete('zzz',consumer.id);await f.business.savePreset('zzz',p.id,p.name,{[provider.id]:true,[consumer.id]:false});const missing=await f.business.presetPlanner.prepare('zzz',p.id);assert.equal(missing.canApply,false);assert.ok(missing.rows.some(row=>row.name==='Consumer'&&row.status==='missing'));
 const subset=await f.business.presetPlanner.prepare('zzz',p.id,{},[consumer.id]);assert.equal(subset.canApply,true);assert.ok(subset.rows.some(row=>row.status==='excluded'));await f.business.presetPlanner.commit('zzz',subset.token);
});
test('preview binds saved preset, root, versions and directory identity; stale plans never change flags',async()=>{
 const f=await fixture(),p=await preset(f),planner=f.business.presetPlanner;
 const edit=await planner.prepare('zzz',p.id);await f.business.savePreset('zzz',p.id,'新名称',p.members);await assert.rejects(planner.commit('zzz',edit.token),/变化/);
 const version=await planner.prepare('zzz',p.id);await write(path.join(f.settings.games.zzz.xxmiRoot,'Resources/Packages/ZZMI/Manifest.json'),JSON.stringify({version:'9.0'}));await assert.rejects(planner.commit('zzz',version.token),/变化/);
 const moved=await planner.prepare('zzz',p.id),mod=(await f.mods.scan('zzz')).mods.find(m=>m.name==='Provider')!;await fs.rename(path.join(f.settings.games.zzz.modsDirectory,mod.relativePath),path.join(f.run,'moved'));await assert.rejects(planner.commit('zzz',moved.token),/变化/);
 const expired=await planner.prepare('zzz',p.id);(planner as any).plans.get(expired.token).expires=0;await assert.rejects(planner.commit('zzz',expired.token),/过期/);
 const root=await planner.prepare('zzz',p.id),settings=await f.store.read();await fs.mkdir(path.join(f.run,'newRoot'));await f.store.save({...settings,games:{...settings.games,zzz:{...settings.games.zzz,modsDirectory:path.join(f.run,'newRoot')}}});await assert.rejects(planner.commit('zzz',root.token),/变化/);
});
test('ancestor-disabled false request still changes own flag; enable and same-name paths are blocked',async()=>{
 const f=await fixture(),root=f.settings.games.zzz.modsDirectory;await write(path.join(root,'DISABLED_Parent/Inner/main.ini'),'[Constants]\nx=1');const inner=(await f.mods.scan('zzz')).mods.find(m=>m.name==='Inner')!,p=(await f.business.savePreset('zzz',null,'自身停用',{[inner.id]:false})).at(-1)!;
 const plan=await f.business.presetPlanner.prepare('zzz',p.id);assert.equal(plan.rows[0].current,false);assert.equal(plan.rows[0].status,'disable');await f.business.presetPlanner.commit('zzz',plan.token);await fs.stat(path.join(root,'DISABLED_Parent/DISABLED_Inner'));
 await f.business.savePreset('zzz',p.id,p.name,{[inner.id]:true});assert.equal((await f.business.presetPlanner.prepare('zzz',p.id)).canApply,false);
 const provider=(await f.mods.scan('zzz')).mods.find(m=>m.name==='Provider')!;await write(path.join(root,'Provider/untouched.txt'),'occupied');await f.business.savePreset('zzz',p.id,p.name,{[provider.id]:true});assert.ok((await f.business.presetPlanner.prepare('zzz',p.id)).blockers.some(text=>text.includes('同名')));
});
test('failed second directory move rolls back the complete preset and original index',async()=>{
 const f=await fixture(),p=await preset(f),plan=await f.business.presetPlanner.prepare('zzz',p.id),before=await fs.readFile(path.join(f.data,'library-zzz.json')),rename=fs.rename;let moves=0;
 fs.rename=async(from,to)=>{if(String(from).includes('DISABLED_')&&!String(from).includes('.kmm-operation-')&&!String(to).includes('.kmm-operation-')&&++moves===2)throw Object.assign(new Error('owned move failure'),{code:'EIO'});return rename(from,to);};
 try{await assert.rejects(f.business.presetPlanner.commit('zzz',plan.token),/owned move failure/);}finally{fs.rename=rename;}
 assert.equal((await f.mods.scan('zzz')).mods.filter(m=>m.enabled).length,0);assert.deepEqual(await fs.readFile(path.join(f.data,'library-zzz.json')),before);assert.deepEqual(await new FileOperations(f.data).list('zzz'),[]);
});
test('metadata changed while preparing a confirmed preset is preserved before the first directory move',async()=>{
 const f=await fixture(),p=await preset(f),plan=await f.business.presetPlanner.prepare('zzz',p.id),file=path.join(f.data,'library-zzz.json'),copy=fs.copyFile;let changed=false;
 fs.copyFile=async(from,to,...args)=>{if(String(from)===file&&!changed){changed=true;const data=JSON.parse(await fs.readFile(file,'utf8'));data.externalNote='keep';await fs.writeFile(file,JSON.stringify(data));}return copy(from,to,...args);};
 try{await assert.rejects(f.business.presetPlanner.commit('zzz',plan.token),/元数据.*改变/);}finally{fs.copyFile=copy;}
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).externalNote,'keep');assert.ok((await f.mods.scan('zzz')).mods.every(mod=>!mod.enabled));assert.deepEqual(await new FileOperations(f.data).list('zzz'),[]);
});

test('content fingerprint ignores only outer name; covers every file, rejects links, cancellation and byte budgets',async()=>{
 const f=await fixture(),directory=path.join(f.settings.games.zzz.modsDirectory,'DISABLED_Provider'),a=await hashModTree(directory);await fs.rename(directory,path.join(f.run,'renamed'));const root=path.join(f.run,'renamed');assert.equal((await hashModTree(root)).hash.sha256,a.hash.sha256);
 await write(path.join(root,'preview.png'),'image');assert.notEqual((await hashModTree(root)).hash.sha256,a.hash.sha256);await assert.rejects(hashModTree(root,{remaining:1}),/预算/);
 const canceled=new AbortController();canceled.abort();await assert.rejects(hashModTree(root,undefined,canceled.signal));await fs.symlink(path.join(f.run,'data'),path.join(root,'linked'),'junction');await assert.rejects(inspectModTree(root),/链接/);
});
test('export records website IDs/download URL and strict hashes for local Mods; importing maps across local UUIDs',async()=>{
 for(const game of ['zzz','endfield'] as const){const from=await fixture(),library=await from.mods.scan(game),mod=library.mods.find(m=>m.name==='Provider')!,context=await from.mods.context(game,mod.id),api={_idRow:123,_sName:'Online',_aGame:{_idRow:game==='zzz'?19567:21842},_aSubmitter:{_sName:'Author'},_aFiles:[{_idRow:456,_sFile:'mod.zip',_nFilesize:1,_sDownloadUrl:'https://gamebanana.com/dl/456'}]};context.record!.remote=bindGameBananaFile(api,123,['https://gamebanana.com/dl/456'],'mod.zip',game).remote;await from.mods.writeRegistry(game,context.data);
  const {file,preview}=await exported(from,game),online=preview.manifest.members.find(m=>m.name==='Provider')!,local=preview.manifest.members.find(m=>m.name==='Consumer')!;assert.equal(online.source?.modId,123);assert.equal(online.source?.fileId,456);assert.equal(online.source?.downloadUrl,'https://gamebanana.com/dl/456');assert.match(local.hash.sha256,/^[a-f0-9]{64}$/);assert.equal(local.source,undefined);assert.ok(!JSON.stringify(preview.manifest).includes(from.run));
  const target=await fixture(),before=(await target.mods.scan(game)).mods.map(m=>[m.id,m.enabled]),plan=await target.manifests.prepareImport(game,file,undefined,signal(),progress);assert.equal(plan.missing.length,0);assert.ok(plan.matches.every(match=>match.modId!==match.member.id&&match.hashMatches));const result=await target.manifests.commit(game,plan.token,{name:'来自另一库',allowMissing:false,includeProfile:false});assert.equal(result.matched,2);assert.deepEqual((await target.mods.scan(game)).mods.map(m=>[m.id,m.enabled]),before);assert.equal((await target.business.presets(game)).find(p=>p.id===result.presetId)!.mode,'states');
 }
});
test('missing names remain in a saved draft, resume after restart and allow explicitly accepted different-hash replacement',async()=>{
 const from=await fixture(),{file}=await exported(from),target=await fixture(),old=await target.mods.scan('zzz');for(const name of ['Provider','Consumer'])await fs.rename(path.join(target.settings.games.zzz.modsDirectory,'DISABLED_'+name),path.join(target.run,'outside-'+name));await target.mods.scan('zzz');
 const missing=await target.manifests.prepareImport('zzz',file,undefined,signal(),progress);assert.deepEqual(missing.missing.sort(),['Consumer','Provider']);await assert.rejects(target.manifests.commit('zzz',missing.token,{name:'缺少清单',allowMissing:false,includeProfile:false}),/Consumer|Provider/);
 const draft=await target.manifests.commit('zzz',missing.token,{name:'缺少清单',allowMissing:true,includeProfile:false}),stored=(await target.business.presets('zzz')).find(p=>p.id===draft.presetId)!;assert.equal(Object.keys(stored.members).length,0);assert.equal(stored.missingMods!.length,2);assert.equal((await target.business.presetPlanner.prepare('zzz',stored.id)).canApply,false);
 const restarted=new PresetManifests(target.data,target.mods,new BusinessService(target.data,target.mods,target.store),target.store),resumed=await restarted.prepareImport('zzz',undefined,stored.id,signal(),progress),source=path.join(target.run,'Replacement');await write(path.join(source,'main.ini'),'[Constants]\ndifferent = 9');const imported=await target.mods.import('zzz',[source],true);assert.equal(imported.importedIds.length,1);assert.equal(imported.library.mods.find(m=>m.id===imported.importedIds[0])!.enabled,false);
 const member=resumed.matches.find(match=>match.member.name==='Consumer')!,choices:ManifestChoice[]=[{key:member.member.key,modId:imported.importedIds[0],acceptDifferentHash:false}];
 const unaccepted=await restarted.revise('zzz',resumed.sessionId,choices,signal(),progress);assert.ok(unaccepted.missing.includes('Consumer'));choices[0].acceptDifferentHash=true;const accepted=await restarted.revise('zzz',resumed.sessionId,choices,signal(),progress);assert.equal(accepted.matches.find(m=>m.member.name==='Consumer')!.hashMatches,false);assert.deepEqual(accepted.missing,['Provider']);
 const result=await restarted.commit('zzz',accepted.token,{name:'缺少清单',allowMissing:true,includeProfile:false});assert.equal(result.presetId,draft.presetId);assert.deepEqual(result.replacements,[{name:'Consumer',replacement:'Replacement'}]);const final=(await target.business.presets('zzz')).find(p=>p.id===draft.presetId)!;assert.equal(final.missingMods![0].name,'Provider');assert.equal(final.members[imported.importedIds[0]],true);assert.ok((await target.mods.scan('zzz')).mods.every(m=>!m.enabled));assert.equal(old.mods.some(m=>m.id===imported.importedIds[0]),false);
});
test('same-name different bytes never auto-match and multiple identical copies require an explicit one-to-one choice',async()=>{
 const from=await fixture(),{file}=await exported(from),target=await fixture();await write(path.join(target.settings.games.zzz.modsDirectory,'DISABLED_Consumer/main.ini'),'[Constants]\nchanged=1');await write(path.join(target.settings.games.zzz.modsDirectory,'DISABLED_Copy/main.ini'),'[Constants]\nProvider = 1\n');await target.mods.scan('zzz');
 const plan=await target.manifests.prepareImport('zzz',file,undefined,signal(),progress);assert.deepEqual(plan.missing.sort(),['Consumer','Provider']);const candidate=(await target.mods.scan('zzz')).mods.find(m=>m.name==='Provider')!;
 await assert.rejects(target.manifests.revise('zzz',plan.sessionId,plan.matches.map(m=>({key:m.member.key,modId:candidate.id,acceptDifferentHash:true})),signal(),progress),/不能映射同一/);
});
test('a missing Mod reimported under its original folder name gets a fresh usable ID without silently replacing old preset members',async()=>{
 const f=await fixture(),p=await preset(f),old=(await f.mods.scan('zzz')).mods.find(m=>m.name==='Consumer')!;await fs.rename(path.join(f.settings.games.zzz.modsDirectory,old.relativePath),path.join(f.run,'oldConsumer'));await f.mods.scan('zzz');const source=path.join(f.run,'Consumer');await write(path.join(source,'main.ini'),'[Constants]\nnewContent=42');const result=await f.mods.import('zzz',[source],true);
 assert.equal(result.importedIds.length,1);const imported=result.library.mods.find(mod=>mod.id===result.importedIds[0])!;assert.ok(imported);assert.notEqual(imported.id,old.id);assert.equal(imported.name,'Consumer');assert.equal(imported.enabled,false);assert.equal((await f.business.presets('zzz')).find(item=>item.id===p.id)!.members[old.id],true);assert.ok((await f.business.presetPlanner.prepare('zzz',p.id)).rows.some(row=>row.id===old.id&&row.status==='missing'));
});
test('foreign game, changed input, changed root, expired match and target rename reject before creating a preset',async()=>{
 const from=await fixture(),{file}=await exported(from),target=await fixture();await assert.rejects(target.manifests.prepareImport('endfield',file,undefined,signal(),progress),/所属游戏/);
 let plan=await target.manifests.prepareImport('zzz',file,undefined,signal(),progress);await fs.appendFile(file,' ');await assert.rejects(target.manifests.commit('zzz',plan.token,{name:'bad',allowMissing:false,includeProfile:false}),/清单.*修改/);
 plan=await target.manifests.prepareImport('zzz',file,undefined,signal(),progress);(target.manifests as any).imports.get(plan.token).expires=0;await assert.rejects(target.manifests.commit('zzz',plan.token,{name:'bad',allowMissing:false,includeProfile:false}),/过期/);
 plan=await target.manifests.prepareImport('zzz',file,undefined,signal(),progress);await target.mods.operate('zzz',plan.matches[0].modId!,{kind:'rename',name:'Renamed'});await assert.rejects(target.manifests.commit('zzz',plan.token,{name:'bad',allowMissing:false,includeProfile:false}),/改变/);assert.equal((await target.business.presets('zzz')).length,0);
 const next=await target.manifests.prepareImport('zzz',file,undefined,signal(),progress),settings=await target.store.read();await fs.mkdir(path.join(target.run,'newRoot'));await target.store.save({...settings,games:{...settings.games,zzz:{...settings.games.zzz,modsDirectory:path.join(target.run,'newRoot')}}});await assert.rejects(target.manifests.commit('zzz',next.token,{name:'bad',allowMissing:false,includeProfile:false}),/根目录/);
});
test('export refuses protected paths, duplicate names preserve old presets and matching cancellation makes no writes',async()=>{
 const f=await fixture(),p=await preset(f),preview=await f.manifests.prepareExport('zzz',p.id,false,signal(),progress);await assert.rejects(f.manifests.export('zzz',preview.token,path.join(f.data,'share.json')),/目录之外/);await assert.rejects(f.manifests.export('zzz',preview.token,path.join(f.settings.games.endfield.modsDirectory,'share.json')),/目录之外/);const file=path.join(f.run,'share.json');await f.manifests.export('zzz',preview.token,file);
 const plan=await f.manifests.prepareImport('zzz',file,undefined,signal(),progress),before=await fs.readFile(path.join(f.data,'presets-zzz.json'));await assert.rejects(f.manifests.commit('zzz',plan.token,{name:p.name,allowMissing:false,includeProfile:false}),/同名/);assert.deepEqual(await fs.readFile(path.join(f.data,'presets-zzz.json')),before);
 const controller=new AbortController();controller.abort();await assert.rejects(f.manifests.prepareImport('zzz',file,undefined,controller.signal,progress));assert.deepEqual(await fs.readFile(path.join(f.data,'presets-zzz.json')),before);
});
test('portable JSON rejects duplicate keys, malformed hash, unsafe URLs, unknown schemas and untrusted profile paths',async()=>{
 assert.throws(()=>parseUniqueJson(Buffer.from('{"a":1,"a":2}')),/重复/);assert.throws(()=>parseUniqueJson(Buffer.from('{"a":1,"\\u0061":2}')),/重复/);const f=await fixture(),p=await preset(f),valid=(await f.manifests.prepareExport('zzz',p.id,false,signal(),progress)).manifest;
 for(const mutate of [(v:any)=>v.schemaVersion=2,(v:any)=>v.members[0].hash.sha256='x',(v:any)=>v.members.push(v.members[0]),(v:any)=>v.members[0].source={provider:'gamebanana',modId:1,fileId:2,entryPath:'',downloadUrl:'file:///C:/private',sourceUrl:'https://gamebanana.com/mods/1'},(v:any)=>v.profile={files:[{key:v.members[0].key,relativePath:'../outside.ini',sha256:'a'.repeat(64)}],compatible:{[v.members[0].key]:'a'.repeat(64)}}]){const value=structuredClone(valid);mutate(value);assert.throws(()=>readPortablePreset(value));}
});
test('independent INI package preserves raw bytes and imports inactive after compatible projection across different live INI',async()=>{
 for(const game of ['zzz','endfield'] as const){const from=await fixture(),p=await preset(from,game,['Provider']),mod=(await from.mods.scan(game)).mods.find(m=>m.name==='Provider')!,ini=path.join(from.settings.games[game].modsDirectory,mod.relativePath,'main.ini'),bytes=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('[Constants]\r\nProvider = 2; 捕获\r\n','utf16le')]);await fs.writeFile(ini,bytes);await from.business.profiles.capture(game,p.id,p.name,[{modId:mod.id,relativePath:'main.ini'}]);await fs.writeFile(ini,'different runtime INI');const {file}=await exported(from,game,true,p.id),target=await fixture(),targetMod=(await target.mods.scan(game)).mods.find(m=>m.name==='Provider')!,targetIni=path.join(target.settings.games[game].modsDirectory,targetMod.relativePath,'main.ini'),before=await fs.readFile(targetIni);
  const initial=await target.manifests.prepareImport(game,file,undefined,signal(),progress),plan=await target.manifests.revise(game,initial.sessionId,[{key:initial.matches[0].member.key,modId:targetMod.id,acceptDifferentHash:true}],signal(),progress);assert.equal(plan.canImportProfile,true);const receipt=await target.manifests.commit(game,plan.token,{name:'外部配置',allowMissing:false,includeProfile:true});assert.equal(receipt.profileImported,true);assert.deepEqual(await fs.readFile(targetIni),before);assert.equal((await target.mods.context(game)).data.activeProfile,undefined);assert.ok((await target.mods.scan(game)).mods.every(m=>!m.enabled));assert.deepEqual((await target.business.profiles.read(game,receipt.presetId,{modId:targetMod.id,relativePath:'main.ini'})).digest,sha(bytes));const apply=await target.business.profiles.prepare(game,receipt.presetId);await target.business.profiles.apply(game,apply.token,'backup');assert.deepEqual(await fs.readFile(path.join(target.settings.games[game].modsDirectory,'Provider/main.ini')),bytes);
 }
});
test('different resource replacement permits state preset but blocks transferring incompatible captured INI',async()=>{
 const from=await fixture(),p=await preset(from,'zzz',['Provider']),mod=(await from.mods.scan('zzz')).mods.find(m=>m.name==='Provider')!;await write(path.join(from.settings.games.zzz.modsDirectory,mod.relativePath,'texture.dds'),'original');await from.business.profiles.capture('zzz',p.id,p.name,[{modId:mod.id,relativePath:'main.ini'}]);const {file}=await exported(from,'zzz',true,p.id),target=await fixture(),local=(await target.mods.scan('zzz')).mods.find(m=>m.name==='Provider')!;await write(path.join(target.settings.games.zzz.modsDirectory,local.relativePath,'texture.dds'),'different');const initial=await target.manifests.prepareImport('zzz',file,undefined,signal(),progress),plan=await target.manifests.revise('zzz',initial.sessionId,[{key:initial.matches[0].member.key,modId:local.id,acceptDifferentHash:true}],signal(),progress);assert.equal(plan.canImportProfile,false);await assert.rejects(target.manifests.commit('zzz',plan.token,{name:'bad',allowMissing:false,includeProfile:true}),/不兼容|未全部/);const result=await target.manifests.commit('zzz',plan.token,{name:'仅启停',allowMissing:false,includeProfile:false});assert.equal(result.profileImported,false);
});
test('configuration ZIP validates whitelist, actual bytes, blob checksums and source revision before export',async()=>{
 const f=await fixture(),p=await preset(f,'zzz',['Provider']),mod=(await f.mods.scan('zzz')).mods.find(m=>m.name==='Provider')!;await f.business.profiles.capture('zzz',p.id,p.name,[{modId:mod.id,relativePath:'main.ini'}]);const preview=await f.manifests.prepareExport('zzz',p.id,true,signal(),progress),bytes=await f.business.profiles.read('zzz',p.id,{modId:mod.id,relativePath:'main.ini'}),blob=Buffer.from(bytes.text),manifest=preview.manifest;
 const file=path.join(f.run,'unsafe.zip');for(const entries of [{'manifest.json':Buffer.from(JSON.stringify(manifest)),'../evil.ini':blob},{'manifest.json':Buffer.from(JSON.stringify(manifest)),['blobs/'+manifest.profile!.files[0].sha256+'.ini']:Buffer.from('tampered')},{'manifest.json':Buffer.from(JSON.stringify(manifest)),'extra.exe':Buffer.from('never run')}]){await fs.writeFile(file,zipSync(entries));await assert.rejects(readPresetPackage(file));}
 assert.throws(()=>encodePresetPackage(manifest,new Map()),/缺失/);const context=await f.mods.context('zzz',mod.id);context.record!.contentRevision='00000000-0000-4000-8000-000000000001';await f.mods.writeRegistry('zzz',context.data);await assert.rejects(f.manifests.prepareExport('zzz',p.id,true,signal(),progress),/不适用/);
});

async function killed(f:Awaited<ReturnType<typeof fixture>>,game:GameId,presetId:string,mode:'apply'|'import',point:string){
 const worker=fork(path.resolve('tests/helpers/preset-workflow-worker.ts'),[f.run,game,presetId,mode,point],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});let stderr='';worker.stderr?.on('data',chunk=>stderr+=chunk);
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{worker.kill();reject(new Error('worker timeout '+stderr));},20000);worker.on('message',(message:any)=>{if(message.paused){clearTimeout(timer);resolve();}else if(message.error){clearTimeout(timer);reject(new Error(message.error));}});worker.once('error',reject);worker.once('exit',code=>{if(code!==null){clearTimeout(timer);reject(new Error('worker exited '+code+' '+stderr));}});});await new Promise<void>(resolve=>{worker.once('exit',()=>resolve());worker.kill('SIGKILL');});
}
test('actual preset child termination after first move rolls back both games without changing INI or identities',async()=>{
 for(const game of ['zzz','endfield'] as const){const f=await fixture(),p=await preset(f,game),before=await fs.readFile(path.join(f.data,'library-'+game+'.json'));await killed(f,game,p.id,'apply','move');const files=new FileOperations(f.data),pending=await files.list(game);assert.equal(pending.length,1);await files.rollback(game,pending[0].id,f.settings.games[game].modsDirectory);assert.deepEqual(await fs.readFile(path.join(f.data,'library-'+game+'.json')),before);assert.ok((await f.mods.scan(game)).mods.every(m=>!m.enabled));}
});
test('actual configuration import termination at prepare, profile publish and index publish recovers without half-valid references',async()=>{
 for(const game of ['zzz','endfield'] as const)for(const point of ['prepared','profile','metadata']){const f=await fixture(),p=await preset(f,game,['Provider']),mod=(await f.mods.scan(game)).mods.find(m=>m.name==='Provider')!;await f.business.profiles.capture(game,p.id,p.name,[{modId:mod.id,relativePath:'main.ini'}]);await exported(f,game,true,p.id);const before=await fs.readFile(path.join(f.data,'presets-'+game+'.json')),registry=await fs.readFile(path.join(f.data,'library-'+game+'.json'));await killed(f,game,p.id,'import',point);const files=new FileOperations(f.data),pending=await files.list(game);assert.equal(pending.length,1);await files.rollback(game,pending[0].id,f.settings.games[game].modsDirectory);assert.deepEqual(await fs.readFile(path.join(f.data,'presets-'+game+'.json')),before);assert.deepEqual(await fs.readFile(path.join(f.data,'library-'+game+'.json')),registry);assert.equal((await f.business.presets(game)).length,1);}
});
