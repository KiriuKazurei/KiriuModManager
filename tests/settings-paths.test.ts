import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {launchPlan} from '../src/main/desktop';
import {gamePathsPatch,acceptSubmittedGamePaths} from '../src/renderer/settings-draft';
import type {GameId} from '../src/shared/contracts';

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
