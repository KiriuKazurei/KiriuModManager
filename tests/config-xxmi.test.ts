import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { defaultSettings, SettingsStore, validateSettings } from '../src/main/settings';
import { inspectXXMI, parseRecursiveIncludes } from '../src/main/xxmi';
import {launchPlan} from '../src/main/desktop';

async function fixture() {
  const testRoot = path.resolve('.run-data', 'tests');
  await fs.mkdir(testRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testRoot, 'kmm-test-'));
  const root = path.join(base, 'XXMI');
  const game = path.join(base, 'game');
  const externalMods = path.join(base, 'External Mods');
  await fs.mkdir(path.join(root, 'Resources', 'Bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'ZZMI', 'Mods'), { recursive: true });
  await fs.mkdir(game); await fs.mkdir(externalMods);
  await fs.writeFile(path.join(root, 'Resources', 'Bin', 'XXMI Launcher.exe'), 'fixture only');
  await fs.writeFile(path.join(root, 'XXMI Launcher Config.json'), JSON.stringify({ Launcher: { enabled_importers: ['ZZMI', 'EFMI'] }, Secrets: { token: 'NEVER_RETURN_ME' }, Importers: { ZZMI: { Importer: { importer_folder: 'ZZMI/', game_folder: game } }, EFMI: { Importer: { importer_folder: 'EFMI/', game_folder: '' } } } }));
  await fs.writeFile(path.join(root, 'ZZMI', 'd3dx.ini'), '[Include]\ninclude=Core\\ZZMI\\main.ini\ninclude_recursive = Mods\nexclude_recursive = DISABLED*\n');
  return { base, root, game, externalMods };
}
test('settings persist selected game and isolated paths across store restarts', async () => {
  const f = await fixture();
  try {
    const store = new SettingsStore(path.join(f.base, 'data'));
    assert.equal((await store.read()).selectedGame, 'zzz');
    const input = defaultSettings(); input.selectedGame = 'endfield';
    input.games.zzz = { xxmiRoot: f.root, gameDirectory: f.game, modsDirectory: path.join(f.root, 'ZZMI', 'Mods') };
    input.games.endfield = { xxmiRoot: path.join(f.base, 'second'), gameDirectory: '', modsDirectory: f.externalMods };
    await store.save(input);
    assert.deepEqual(await new SettingsStore(path.join(f.base, 'data')).read(), input);
  } finally { await fs.rm(f.base, { recursive: true }); }
});
test('invalid game IDs and relative paths are rejected; corrupt settings are preserved', async () => {
  for (const id of ['toString', '__proto__', '', 5, null]) assert.throws(() => validateSettings({ ...defaultSettings(), selectedGame: id }));
  const settings = defaultSettings(); settings.games.zzz.xxmiRoot = 'relative/path';
  assert.throws(() => validateSettings(settings), /绝对/);
  const testRoot = path.resolve('.run-data', 'tests');
  await fs.mkdir(testRoot, { recursive: true });
  const base = await fs.mkdtemp(path.join(testRoot, 'kmm-corrupt-'));
  try {
    const store = new SettingsStore(base); await fs.writeFile(store.file, '{broken');
    await assert.rejects(store.read(), /原文件已保留/);
    assert.equal(await fs.readFile(store.file, 'utf8'), '{broken');
  } finally { await fs.rm(base, { recursive: true }); }
});
test('reads outer launcher root, actual selected importer paths and never returns Secrets', async () => {
  const f = await fixture();
  try {
    const ini = path.join(f.root, 'ZZMI', 'd3dx.ini');
    const before = await fs.readFile(ini);
    const found = await inspectXXMI('zzz', f.root);
    assert.equal(found.installed, true); assert.equal(found.gameDirectory, f.game);
    assert.equal(found.launcherPath, path.join(f.root, 'Resources', 'Bin', 'XXMI Launcher.exe'));
    assert.deepEqual(found.modsDirectories, [path.join(f.root, 'ZZMI', 'Mods')]);
    assert.deepEqual(found.modsExist, [true]);
    assert.equal(JSON.stringify(found).includes('NEVER_RETURN_ME'), false);
    assert.deepEqual(await fs.readFile(ini), before);
    const efmi = await inspectXXMI('endfield', f.root);
    assert.equal(efmi.launcherExists, true); assert.equal(efmi.importerExists, false); assert.equal(efmi.installed, false);
    assert.deepEqual(efmi.modsDirectories, []);
  } finally { await fs.rm(f.base, { recursive: true }); }
});
test('absolute and relative recursive includes, multiple paths and game isolation', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'EFMI'), { recursive: true });
    await fs.writeFile(path.join(f.root, 'EFMI', 'd3dx.ini'), `[Include]\ninclude_recursive = "${f.externalMods}"\ninclude_recursive = OtherMods ; comment\n`);
    const efmi = await inspectXXMI('endfield', f.root);
    assert.equal(efmi.installed, true);
    assert.deepEqual(efmi.modsDirectories, [f.externalMods, path.join(f.root, 'EFMI', 'OtherMods')]);
    assert.deepEqual(efmi.modsExist, [true, false]);
    assert.deepEqual((await inspectXXMI('zzz', f.root)).modsDirectories, [path.join(f.root, 'ZZMI', 'Mods')]);
    assert.deepEqual(parseRecursiveIncludes(';include_recursive=No\n[include]\ninclude_recursive=Mods\n[Other]\ninclude_recursive=Ignore'), ['Mods']);
    await assert.rejects(inspectXXMI('zzz', ''), /根目录/);
    const missing = await inspectXXMI('zzz', path.join(f.base, 'absent'));
    assert.equal(missing.installed, false);
  } finally { await fs.rm(f.base, { recursive: true }); }
});

for(const gameId of ['zzz','endfield']as const)test(gameId+': launcher-only installation opens the GUI for manual component installation, then detects the actual root directory',async()=>{
 const f=await fixture(),importer=gameId==='zzz'?'ZZMI':'EFMI',other=gameId==='zzz'?'EFMI':'ZZMI';
 if(gameId==='zzz')await fs.rename(path.join(f.root,'ZZMI'),path.join(f.root,'EFMI'));
 const configFile=path.join(f.root,'XXMI Launcher Config.json');await fs.writeFile(configFile,JSON.stringify({Launcher:{enabled_importers:[importer]},Importers:{[importer]:{Importer:{importer_folder:other,game_folder:f.game}}}}));
 const configBefore=await fs.readFile(configFile),fields={xxmiRoot:f.root,gameDirectory:'',modsDirectory:f.externalMods};
 const missing=await inspectXXMI(gameId,f.root);assert.equal(missing.launcherExists,true);assert.equal(missing.installed,false);assert.equal(missing.importerDirectory,path.join(f.root,importer));assert.equal(missing.importerExists,false);assert.ok(missing.warnings.some(w=>w.includes('手动点击安装')));
 for(const mode of ['gui','game']as const){const plan=await launchPlan(gameId,fields,mode);assert.deepEqual(plan.args,['--xxmi',importer]);assert.equal(plan.installImporter,importer);assert.equal(plan.executable,path.join(f.root,'Resources','Bin','XXMI Launcher.exe'));}
 await assert.rejects(fs.stat(path.join(f.root,importer)),{code:'ENOENT'});assert.deepEqual(await fs.readFile(configFile),configBefore);
 await fs.mkdir(path.join(f.root,importer));const present=await inspectXXMI(gameId,f.root);assert.equal(present.installed,true);assert.equal(present.importerExists,true);assert.equal(present.iniExists,false);assert.deepEqual(present.modsDirectories,[]);
 const exe=gameId==='zzz'?'ZenlessZoneZero.exe':'Endfield.exe';await fs.writeFile(path.join(f.game,exe),'fixture, never execute');
 const plan=await launchPlan(gameId,{...fields,gameDirectory:f.game},'game');assert.deepEqual(plan.args,['--nogui','--xxmi',importer]);assert.equal(plan.installImporter,undefined);
 assert.deepEqual(await fs.readFile(configFile),configBefore);
});
