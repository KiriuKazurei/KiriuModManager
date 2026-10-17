import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {launchPlan} from '../src/main/desktop';
import {gamePathsPatch,acceptSubmittedGamePaths} from '../src/renderer/settings-draft';
import type {GameId} from '../src/shared/contracts';
import {inspectXXMI} from '../src/main/xxmi';
import {normalizeGamePathInput} from '../src/shared/path-input';
import {validatePaths} from '../src/main/sync';

async function fixture(){
  const parent=path.resolve('.run-data/path-settings-tests');
  await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'run-'));
  const store=new SettingsStore(path.join(root,'data'));
  const settings=defaultSettings();settings.selectedGame='endfield';
  settings.desktop={marketUrl:'https://example.com/mods',updateUrl:'',closeToTray:false};
  const installations={} as Record<GameId,{xxmi:string;launcher:string;game:string;executable:string;mods:string}>;
  for(const game of ['zzz','endfield'] as const){
    const xxmi=path.join(root,game,'XXMI'),directory=path.join(root,game,'Game');
    const importer=game==='zzz'?'ZZMI':'EFMI';
    const launcher=path.join(xxmi,'Resources','Bin','XXMI Launcher.exe');
    const executable=path.join(directory,game==='zzz'?'ZenlessZoneZero.exe':'Endfield.exe');
    const mods=path.join(root,game,'Mods');
    for(const file of [launcher,executable,path.join(xxmi,importer,'d3dx.ini')]){
      await fs.mkdir(path.dirname(file),{recursive:true});
      await fs.writeFile(file,file.endsWith('.ini')?'[Include]\ninclude_recursive=Mods':'fixture, never execute');
    }
    await fs.writeFile(path.join(xxmi,'XXMI Launcher Config.json'),JSON.stringify({Importers:{[importer]:{Importer:{game_folder:directory,importer_folder:importer}}}}));
    await fs.mkdir(mods,{recursive:true});
    installations[game]={xxmi,launcher,game:directory,executable,mods};
    settings.games[game]={xxmiRoot:launcher,gameDirectory:executable,modsDirectory:mods};
  }
  await store.save(settings);
  return {root,store,settings,installations};
}

test('legacy saved EXE paths can be explicitly saved as directories and produce valid launch plans for both games',async()=>{
  const {store,settings,installations}=await fixture();
  for(const game of ['zzz','endfield'] as const){
    const before=await store.read(),f=installations[game],other=game==='zzz'?'endfield':'zzz';
    const patch=gamePathsPatch({draft:before,baseline:before},game);
    assert.deepEqual(patch,{xxmiRoot:f.launcher,gameDirectory:f.executable});
    const saved=await store.saveGamePaths(game,patch);
    assert.equal(saved.games[game].xxmiRoot,f.xxmi);assert.equal(saved.games[game].gameDirectory,f.game);
    assert.deepEqual(saved.games[other],before.games[other]);
    assert.deepEqual(saved.desktop,settings.desktop);assert.equal(saved.selectedGame,'endfield');
    const reloaded=await new SettingsStore(path.dirname(store.file)).read();assert.deepEqual(reloaded,saved);
    const plan=await launchPlan(game,reloaded.games[game],'gui');assert.equal(plan.executable,f.launcher);
    assert.deepEqual(gamePathsPatch({draft:saved,baseline:saved},game),{});
    const accepted=acceptSubmittedGamePaths({draft:before,baseline:before},saved,game,patch);
    assert.deepEqual(accepted.draft.games[game],saved.games[game]);
  }
});

test('quoted pasted executables and queued game patches retain other settings',async()=>{
  const {store,settings,installations}=await fixture();
  await Promise.all((['zzz','endfield'] as const).map(game=>store.saveGamePaths(game,{
    xxmiRoot:' "'+installations[game].launcher+'" ',gameDirectory:' "'+installations[game].executable+'" ',
  })));
  const saved=await store.read();
  for(const game of ['zzz','endfield'] as const){assert.equal(saved.games[game].xxmiRoot,installations[game].xxmi);assert.equal(saved.games[game].gameDirectory,installations[game].game);}
  assert.deepEqual(saved.desktop,settings.desktop);assert.equal(saved.selectedGame,'endfield');
});

test('outer, Resources, Bin and EXE locations resolve to one XXMI installation for both games',async()=>{
 const {store,installations}=await fixture();
 for(const game of ['zzz','endfield']as const){
  const f=installations[game];
  for(const xxmiRoot of [f.xxmi,path.join(f.xxmi,'Resources'),path.dirname(f.launcher),path.dirname(f.launcher)+path.sep,' "'+f.launcher+'" ']){
   const inspection=await inspectXXMI(game,xxmiRoot);assert.equal(inspection.installed,true);assert.equal(inspection.xxmiRoot,f.xxmi);assert.equal(inspection.launcherPath,f.launcher);
   const saved=await store.saveGamePaths(game,{xxmiRoot,gameDirectory:f.game});assert.equal(saved.games[game].xxmiRoot,f.xxmi);
  }
 }
 assert.equal(normalizeGamePathInput('zzz','xxmiRoot','K:\\Resources\\Bin\\'),'K:\\');
 assert.equal(normalizeGamePathInput('zzz','xxmiRoot','K:/XXMI/resources/'),'K:/XXMI');
});

test('game outer folders, EXE directories and files save one canonical location and legacy aliases launch without rewriting',async()=>{
 const {store,installations}=await fixture();
 for(const game of ['zzz','endfield']as const){
  const f=installations[game];
  for(const gameDirectory of [path.dirname(f.game),f.game,f.executable,' "'+f.executable+'" ']){
   const saved=await store.saveGamePaths(game,{xxmiRoot:path.dirname(f.launcher),gameDirectory});assert.equal(saved.games[game].gameDirectory,f.game);
   const fields={...saved.games[game],xxmiRoot:path.dirname(f.launcher),gameDirectory};const before=await fs.readFile(store.file);
   assert.equal((await launchPlan(game,fields,'gui')).executable,f.launcher);
   assert.equal((await launchPlan(game,fields,'game')).executable,f.launcher);
   assert.deepEqual(await fs.readFile(store.file),before);
  }
 }
});

test('ambiguous outer game folders and linked inner XXMI directories cannot replace saved settings',async()=>{
 const {root,store,installations}=await fixture(),f=installations.zzz;
 const second=path.join(path.dirname(f.game),'Another','ZenlessZoneZero.exe');await fs.mkdir(path.dirname(second),{recursive:true});await fs.writeFile(second,'other install');
 const before=await fs.readFile(store.file);await assert.rejects(store.saveGamePaths('zzz',{gameDirectory:path.dirname(f.game)}),/唯一/);assert.deepEqual(await fs.readFile(store.file),before);
 const alias=path.join(root,'Alias','Resources','Bin');await fs.mkdir(path.dirname(alias),{recursive:true});await fs.symlink(path.dirname(f.launcher),alias,process.platform==='win32'?'junction':'dir');
 await assert.rejects(store.saveGamePaths('zzz',{xxmiRoot:alias}));await assert.rejects(inspectXXMI('zzz',alias));assert.deepEqual(await fs.readFile(store.file),before);
});

test('outer game selection ignores nested backups inside the same already recognized installation',async()=>{
 const {store,installations}=await fixture(),f=installations.zzz;
 const backup=path.join(f.game,'Backup','ZenlessZoneZero.exe');await fs.mkdir(path.dirname(backup),{recursive:true});await fs.writeFile(backup,'old executable');
 const saved=await store.saveGamePaths('zzz',{gameDirectory:path.dirname(f.game)});assert.equal(saved.games.zzz.gameDirectory,f.game);
 assert.equal((await launchPlan('zzz',{...saved.games.zzz,xxmiRoot:f.xxmi},'game')).executable,f.launcher);
});

test('sync and deployment resolve directory aliases before choosing their write locations',async()=>{
 const {installations}=await fixture();
 for(const game of ['zzz','endfield']as const){const f=installations[game];
  const fields=await validatePaths(game,{xxmiRoot:path.dirname(f.launcher),gameDirectory:path.dirname(f.game),modsDirectory:f.mods});
  assert.deepEqual(fields,{xxmiRoot:f.xxmi,gameDirectory:f.game,modsDirectory:f.mods});
 }
});

test('file inputs, wrong-game executables and missing game locations reject without overwriting saved bytes',async()=>{
  const {root,store,installations}=await fixture();
  const text=path.join(root,'notes.txt');await fs.writeFile(text,'keep');
  const unchanged=await fs.readFile(store.file);
  const invalid=[
    {xxmiRoot:text},{gameDirectory:text},{modsDirectory:text},{modsDirectory:installations.zzz.executable},
    {gameDirectory:installations.endfield.executable},{gameDirectory:path.join(root,'missing-game')},
    {xxmiRoot:path.join(root,'missing','Resources','Bin','XXMI Launcher.exe')},
    {gameDirectory:path.join(root,'missing','ZenlessZoneZero.exe')},{modsDirectory:path.join(text,'Mods')},
    {xxmiRoot:'relative'},{gameDirectory:123},{xxmiRoot:'bad\0path'},
  ];
  for(const patch of invalid){await assert.rejects(async()=>store.saveGamePaths('zzz',patch),JSON.stringify(patch));assert.deepEqual(await fs.readFile(store.file),unchanged);}
});

test('new XXMI and Mod directories remain valid setup targets without being created by saving',async()=>{
  const {root,store,installations}=await fixture();
  const xxmiRoot=path.join(root,'New','XXMI'),modsDirectory=path.join(root,'New','Mods');
  const saved=await store.saveGamePaths('zzz',{xxmiRoot,modsDirectory,gameDirectory:installations.zzz.game});
  assert.equal(saved.games.zzz.xxmiRoot,xxmiRoot);assert.equal(saved.games.zzz.modsDirectory,modsDirectory);
  await assert.rejects(fs.stat(xxmiRoot),{code:'ENOENT'});await assert.rejects(fs.stat(modsDirectory),{code:'ENOENT'});
  assert.equal((await store.saveGamePaths('zzz',{gameDirectory:''})).games.zzz.gameDirectory,'');
});

test('normalization response preserves a newer edit and another game draft',async()=>{
  const {settings,installations}=await fixture();
  const draft=structuredClone(settings),patch=gamePathsPatch({draft,baseline:settings},'zzz');
  draft.games.zzz.gameDirectory='D:\\Newer game draft';draft.games.endfield.modsDirectory='D:\\Other draft';
  const saved=structuredClone(settings);saved.games.zzz.xxmiRoot=installations.zzz.xxmi;saved.games.zzz.gameDirectory=installations.zzz.game;
  const accepted=acceptSubmittedGamePaths({draft,baseline:settings},saved,'zzz',patch);
  assert.equal(accepted.draft.games.zzz.xxmiRoot,installations.zzz.xxmi);
  assert.equal(accepted.draft.games.zzz.gameDirectory,'D:\\Newer game draft');
  assert.equal(accepted.draft.games.endfield.modsDirectory,'D:\\Other draft');
});
