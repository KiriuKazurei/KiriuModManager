import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {defaultSettings,mergeGamePaths,SettingsStore} from '../src/main/settings';

async function fixture(){
 const parent=path.resolve('.run-data/default-mod-directory-tests');await fs.mkdir(parent,{recursive:true});
 const run=await fs.mkdtemp(path.join(parent,'run-'));const install=path.join(run,'管理器'),data=path.join(run,'profile');
 return {run,install,data,store:new SettingsStore(data,install)};
}
test('first read creates separate default libraries and persists stable paths across concurrent reads and restarts',async()=>{
 const f=await fixture();const results=await Promise.all(Array.from({length:5},()=>f.store.read()));
 for(const settings of results){assert.deepEqual(settings,defaultSettings(f.install));for(const game of ['zzz','endfield']as const)assert.equal((await fs.stat(settings.games[game].modsDirectory)).isDirectory(),true);}
 const file=await fs.readFile(f.store.file,'utf8');assert.deepEqual(JSON.parse(file),results[0]);
 const movedInstall=path.join(f.run,'moved-manager');assert.deepEqual(await new SettingsStore(f.data,movedInstall).read(),results[0]);
 await assert.rejects(fs.stat(movedInstall),{code:'ENOENT'});
});
test('legacy empty paths acquire defaults without overwriting configured libraries, game selection or preferences',async()=>{
 const f=await fixture();const settings=defaultSettings();settings.selectedGame='endfield';settings.games.zzz={xxmiRoot:path.join(f.run,'XXMI'),gameDirectory:path.join(f.run,'game'),modsDirectory:path.join(f.run,'existing-mods')};
 settings.desktop={marketUrl:'https://example.com/mods',updateUrl:'',closeToTray:false};await fs.mkdir(settings.games.zzz.modsDirectory,{recursive:true});await fs.writeFile(path.join(settings.games.zzz.modsDirectory,'keep.ini'),'untouched');
 await new SettingsStore(f.data).save(settings);const next=await f.store.read();
 assert.deepEqual(next.games.zzz,settings.games.zzz);assert.equal(next.games.endfield.modsDirectory,path.join(f.install,'Mods','Endfield'));assert.equal(next.selectedGame,'endfield');assert.deepEqual(next.desktop,settings.desktop);
 assert.equal(await fs.readFile(path.join(settings.games.zzz.modsDirectory,'keep.ini'),'utf8'),'untouched');await assert.rejects(fs.stat(path.join(f.install,'Mods','ZZZ')),{code:'ENOENT'});
});
test('custom path saves stay custom and clearing a path restores the default in the returned and persisted settings',async()=>{
 const f=await fixture();const original=await f.store.read(),custom=path.join(f.run,'custom');
 const saved=await f.store.save(mergeGamePaths(original,'zzz',{modsDirectory:custom}));assert.equal(saved.games.zzz.modsDirectory,custom);
 const reset=await f.store.save(mergeGamePaths(saved,'zzz',{modsDirectory:''}));assert.equal(reset.games.zzz.modsDirectory,path.join(f.install,'Mods','ZZZ'));assert.deepEqual(await f.store.read(),reset);
 const next=await f.store.saveGamePathsIfCurrent('zzz',reset.games.zzz,{...reset.games.zzz,gameDirectory:path.join(f.run,'new-game')});assert.equal(next.games.zzz.modsDirectory,reset.games.zzz.modsDirectory);
 await assert.rejects(f.store.saveGamePathsIfCurrent('zzz',reset.games.zzz,{...reset.games.zzz,xxmiRoot:path.join(f.run,'stale')}),/变化/);
});
test('corrupt configuration and blocked default directory preserve original settings bytes',async()=>{
 const f=await fixture();await fs.mkdir(f.data,{recursive:true});await fs.writeFile(f.store.file,'{broken');await assert.rejects(f.store.read(),/原文件已保留/);assert.equal(await fs.readFile(f.store.file,'utf8'),'{broken');await assert.rejects(fs.stat(f.install),{code:'ENOENT'});
 const g=await fixture();await new SettingsStore(g.data).save(defaultSettings());const before=await fs.readFile(g.store.file);await fs.mkdir(g.install,{recursive:true});await fs.writeFile(path.join(g.install,'Mods'),'existing file');await assert.rejects(g.store.read(),/无法创建默认 Mod 目录/);assert.deepEqual(await fs.readFile(g.store.file),before);assert.equal(await fs.readFile(path.join(g.install,'Mods'),'utf8'),'existing file');
});
