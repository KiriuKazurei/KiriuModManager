import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { DeploymentService } from '../src/main/deployment';
import { extractZip } from '../src/main/archive';
import { syncXXMIPaths, patchFirstRecursiveInclude,validatePaths } from '../src/main/sync';
import { OFFICIAL_SOURCES, verifySignature } from '../src/main/releases';
const { createFixtureServer } = require('./fixture-server.cjs');
async function directory() { const root = path.resolve('.run-data', 'tests'); await fs.mkdir(root, { recursive: true }); return fs.mkdtemp(path.join(root, 'deploy-')); }
const runtime = async () => ({ installed: true, message: 'fixture runtime only', downloadUrl: 'https://aka.ms/vs/17/release/vc_redist.x64.exe' });
test('HTTP download / verify / unzip / deploy / sync works for both games with signed library manifests', async () => {
  const base = await directory(); const fixture = await createFixtureServer();
  try {
    const service = new DeploymentService({ fetch: fixture.fetch, cacheDirectory: path.join(base, 'cache'), checkRuntime: runtime, sources: game => [fixture.sources.Launcher, fixture.sources[game === 'zzz' ? 'ZZMI' : 'EFMI'], fixture.sources.XXMI] });
    for (const gameId of ['zzz', 'endfield'] as const) {
      const importer = gameId === 'zzz' ? 'ZZMI' : 'EFMI'; const game = path.join(base, gameId, 'game'); await fs.mkdir(game, { recursive: true });
      await fs.writeFile(path.join(game, gameId === 'zzz' ? 'ZenlessZoneZero.exe' : 'Endfield.exe'), 'fixture only');
      const paths = { xxmiRoot: path.join(base, gameId, 'XXMI'), gameDirectory: game, modsDirectory: path.join(base, gameId, 'Custom Mods') };
      const result = await service.deploy(gameId, paths);
      assert.equal(result.filesDeployed, true); assert.equal(result.ready, true); assert.equal(result.inspection.installed, true);
      assert.deepEqual(result.inspection.modsDirectories, [paths.modsDirectory]);
      assert.equal(service.progress.stage, 'complete');
      const config = JSON.parse(await fs.readFile(path.join(paths.xxmiRoot, 'XXMI Launcher Config.json'), 'utf8'));
      assert.equal(config.Importers[importer].Importer.d3dx_ini.core.Include.include_recursive, paths.modsDirectory);
      assert.equal(config.Importers[importer].Importer.d3dx_ini.core.Loader.loader, 'XXMI Launcher.exe');
      for (const file of ['3dmloader.dll', 'd3d11.dll', 'd3dcompiler_47.dll']) assert.equal((await fs.stat(path.join(paths.xxmiRoot, 'Resources', 'Packages', 'XXMI', file))).isFile(), true);
      for (const file of ['d3d11.dll', 'd3dcompiler_47.dll']) assert.equal((await fs.stat(path.join(paths.xxmiRoot, importer, file))).isFile(), true);
      await assert.rejects(fs.stat(path.join(paths.xxmiRoot, importer, 'ShaderFixes', 'obsolete.txt')), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(paths.xxmiRoot, importer, 'Core', 'stay.txt'), 'utf8'), 'do not execute PreLaunch');
      await assert.rejects(service.deploy(gameId, paths), /已有内容/);
      const ini = await fs.readFile(path.join(paths.xxmiRoot, importer, 'd3dx.ini'), 'utf8'); assert.match(ini, /preserve comment/); assert.match(ini, /keep = yes/);
    }
    assert.ok(fixture.requestCount() >= 14);
  } finally { await fixture.close(); await fs.rm(base, { recursive: true }); }
});
test('explicit path sync preserves other games, Secrets, comments and extra recursive directories', async () => {
  const base = await directory();
  try {
    const root = path.join(base, 'XXMI'); const importer = path.join(root, 'ZZMI'); const game = path.join(base, 'Game');
    await fs.mkdir(path.join(root, 'Resources', 'Bin'), { recursive: true }); await fs.mkdir(path.join(root, 'Resources', 'Packages', 'XXMI'), { recursive: true }); await fs.mkdir(importer); await fs.mkdir(game);
    await fs.writeFile(path.join(game, 'ZenlessZoneZero.exe'), 'fixture'); await fs.writeFile(path.join(root, 'Resources', 'Bin', 'XXMI Launcher.exe'), 'fixture');
    const configPath = path.join(root, 'XXMI Launcher Config.json');
    const config = { Launcher: { active_importer: 'EFMI', enabled_importers: ['EFMI'], proxy: { keep: true } }, Secrets: { token: 'preserved-only-in-file' }, Importers: { EFMI: { Importer: { game_folder: 'untouched', custom_launch: 'preserve' } }, ZZMI: { Importer: { importer_folder: 'ZZMI/', game_folder: 'old', d3dx_ini: { core: { Loader: { loader: 'Custom Loader.exe' }, Rendering: { custom: 1 } } } } } } };
    const raw = JSON.stringify(config); await fs.writeFile(configPath, raw);
    const ini = '; header\r\n[Include]\r\ninclude=Core\\ZZMI\\main.ini\r\ninclude_recursive=Mods ; keep\r\ninclude_recursive=Extra\r\nexclude_recursive=DISABLED*\r\n[Other]\r\nkeep = 1\r\n'; await fs.writeFile(path.join(importer, 'd3dx.ini'), ini);
    await fs.writeFile(path.join(root, 'Resources', 'Packages', 'XXMI', 'Manifest.json'), '{"version":"1.2.2","signatures":{}}');
    const paths = { xxmiRoot: root, gameDirectory: game, modsDirectory: path.join(base, 'Custom Mods') };
    const result = await syncXXMIPaths('zzz', paths);
    const updated = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.deepEqual(updated.Importers.EFMI, config.Importers.EFMI); assert.deepEqual(updated.Secrets, config.Secrets); assert.deepEqual(updated.Launcher.proxy, config.Launcher.proxy);
    assert.equal(updated.Launcher.active_importer, 'EFMI'); assert.equal(updated.Importers.ZZMI.Importer.d3dx_ini.core.Loader.loader, 'Custom Loader.exe');
    assert.equal(updated.Importers.ZZMI.Importer.d3dx_ini.core.Include.include_recursive, paths.modsDirectory);
    assert.equal(await fs.readFile(path.join(result.backupDirectory, 'XXMI Launcher Config.json'), 'utf8'), raw);
    assert.equal(await fs.readFile(path.join(result.backupDirectory, 'd3dx.ini'), 'utf8'), ini);
    const patched = await fs.readFile(path.join(importer, 'd3dx.ini'), 'utf8'); assert.match(patched, /include_recursive=Extra/); assert.match(patched, /exclude_recursive=DISABLED\*/); assert.match(patched, /keep = 1/);
    await fs.writeFile(path.join(root, 'Resources', 'Packages', 'XXMI', 'Manifest.json'), '{"version":"1.1.9"}');
    await assert.rejects(syncXXMIPaths('zzz', { ...paths, modsDirectory: path.join(base, 'New') }), /1.2.0/);
    assert.equal(await fs.readFile(path.join(importer, 'd3dx.ini'), 'utf8'), patched);
  } finally { await fs.rm(base, { recursive: true }); }
});
test('network / signature / wrong game errors never report successful deployment; missing runtime stays unready', async () => {
  const base = await directory(); const offline = await createFixtureServer({ offline: true }); const good = await createFixtureServer();
  try {
    const game = path.join(base, 'game'); await fs.mkdir(game);
    const fields = { xxmiRoot: path.join(base, 'XXMI'), gameDirectory: game, modsDirectory: path.join(base, 'Mods') };
    const create = (fixture: any, checked = runtime, corrupt = false) => new DeploymentService({ fetch: fixture.fetch, cacheDirectory: path.join(base, 'cache'), checkRuntime: checked, sources: () => [fixture.sources.Launcher, { ...fixture.sources.ZZMI, publicKey: corrupt ? OFFICIAL_SOURCES.ZZMI.publicKey : fixture.publicKey }, fixture.sources.XXMI] });
    await assert.rejects(create(good).deploy('zzz', fields), /ZenlessZoneZero/);
    await fs.writeFile(path.join(game, 'ZenlessZoneZero.exe'), 'fixture');
    const network = create(offline); await assert.rejects(network.deploy('zzz', fields), /503/); assert.equal(network.progress.stage, 'error');
    const signatures = create(good, runtime, true); await assert.rejects(signatures.deploy('zzz', fields), /签名/); await assert.rejects(fs.stat(fields.xxmiRoot), { code: 'ENOENT' });
    const service = create(good, async () => ({ ...await runtime(), installed: false })); const result = await service.deploy('zzz', fields);
    assert.equal(result.filesDeployed, true); assert.equal(result.ready, false); assert.equal(result.runtime.installed, false);
  } finally { await offline.close(); await good.close(); await fs.rm(base, { recursive: true }); }
});
test('ZIP traversal and migration paths rejected; INI patch retains extra includes', async () => {
  const base = await directory();
  try {
    const archive = path.join(base, 'unsafe.zip'); await fs.writeFile(archive, zipSync({ '../escape.txt': strToU8('escape') }));
    await assert.rejects(extractZip(archive, path.join(base, 'extracted')), /invalid|unsafe|不安全|越出|relative/i);
    assert.equal(verifySignature(Buffer.from('test'), 'invalid', OFFICIAL_SOURCES.XXMI.publicKey), false);
    const patched = patchFirstRecursiveInclude('[Include]\ninclude_recursive=Mods\ninclude_recursive=Other\n[Next]\nkeep=1', 'Custom');
    assert.match(patched, /include_recursive=Custom/); assert.match(patched, /include_recursive=Other/); assert.match(patched, /keep=1/);
  } finally { await fs.rm(base, { recursive: true }); }
});

test('deployment and synchronization reject a drive-root Mod directory before writing external configuration',async()=>{
 const parent=path.resolve('.run-data/modules-review/phase1-service');await fs.mkdir(parent,{recursive:true});const base=await fs.mkdtemp(path.join(parent,'run-'));
 try{for(const gameId of ['zzz','endfield'] as const){const game=path.join(base,gameId,'Game');const xxmiRoot=path.join(base,gameId,'XXMI');await fs.mkdir(game,{recursive:true});await fs.mkdir(xxmiRoot,{recursive:true});await fs.writeFile(path.join(game,gameId==='zzz'?'ZenlessZoneZero.exe':'Endfield.exe'),'fixture; never execute');const configFile=path.join(xxmiRoot,'XXMI Launcher Config.json');const original='{"Secrets":{"fixture":"preserve"}}';await fs.writeFile(configFile,original);const fields={xxmiRoot,gameDirectory:game,modsDirectory:path.parse(base).root};await assert.rejects(validatePaths(gameId,fields),/Mod.*磁盘根/);await assert.rejects(syncXXMIPaths(gameId,fields),/Mod.*磁盘根/);assert.equal(await fs.readFile(configFile,'utf8'),original);await assert.rejects(fs.stat(path.join(xxmiRoot,'.kmm-backups')),{code:'ENOENT'});}}
 finally{await fs.rm(base,{recursive:true});}
});
