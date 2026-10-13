import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { createFixtureServer } = require('../tests/fixture-server.cjs');
const fixture = await createFixtureServer();
const offlineFixture=await createFixtureServer({offline:true});
const parent = path.resolve(process.env.KMM_SMOKE_DIR || '.run-data/deployment-smoke'); await fs.mkdir(parent, { recursive: true });
const run = await fs.mkdtemp(path.join(parent, 'run-')); const data = path.join(run, 'data');
const env = { ...process.env, KMM_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.KMM_DEV_URL;
let app;
const pageErrors = [];
async function launch(inject = false) {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow(); page.on('pageerror', error => pageErrors.push(error.message));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '路径与加载器', exact: true }).waitFor();
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; for (let i = 0; i < 200 && !win.isVisible(); i++) await new Promise(resolve => setTimeout(resolve, 50));
    if (!win.isVisible()) throw new Error('Electron window is not visible');
  });
  if (inject) {
    // Injection happens through the privileged Playwright test driver, never through renderer IPC/env.
    await app.evaluate(({ net }, { url, publicKey, runtimeModule, releaseModule }) => {
      const load = process.getBuiltinModule('module').createRequire(releaseModule);
      const releases = load(releaseModule);
      for (const source of Object.values(releases.OFFICIAL_SOURCES)) source.publicKey = publicKey;
      globalThis.kmmFixtureUrl=url;globalThis.kmmRuntimeInstalled=true;
      net.fetch = (official, options) => fetch(globalThis.kmmFixtureUrl + new URL(official).pathname, options);
      // Production retains its real registry check; this fixture controls only the runtime result.
      const runtime = load(runtimeModule);
      runtime.checkRuntime = async () => ({ installed: globalThis.kmmRuntimeInstalled, message: globalThis.kmmRuntimeInstalled?'已检测到 Microsoft Visual C++ x64 运行库。':'fixture: 未确认 Microsoft Visual C++ x64 运行库。', downloadUrl: runtime.VC_DOWNLOAD_URL });
    }, { url: fixture.url, publicKey: fixture.publicKey, runtimeModule: path.resolve('dist/main/runtime.js'), releaseModule: path.resolve('dist/main/releases.js') });
  }
  return page;
}
try {
  let page = await launch(true);
  async function captureChanges(){await page.evaluate(()=>{window.p1Unsubscribe?.();window.p1Changes=[];window.p1Unsubscribe=window.kmm.onDesktopChange(event=>window.p1Changes.push(event));});}
  async function settingsChanged(gameId){await page.waitForFunction(()=>window.p1Changes.length>0);assert.deepEqual(await page.evaluate(()=>window.p1Changes[0]),{gameId,settingsChanged:true});}
  await page.locator('.deploy-card > summary').click();
  const results = [];
  for (const gameId of ['zzz', 'endfield']) {
    const importer = gameId === 'zzz' ? 'ZZMI' : 'EFMI';
    if (gameId === 'endfield') { await page.getByLabel('当前游戏',{exact:true}).selectOption('endfield');await page.waitForFunction(()=>document.querySelector('.current-game-select').value==='endfield'&&!document.querySelector('.current-game-select').disabled); }
    const game = path.join(run, gameId, 'Game'); const root = path.join(run, gameId, 'XXMI'); const mods = path.join(run, gameId, 'Custom Mods');
    await fs.mkdir(game, { recursive: true }); await fs.writeFile(path.join(game, gameId === 'zzz' ? 'ZenlessZoneZero.exe' : 'Endfield.exe'), 'fixture only');
    await page.getByLabel('XXMI 安装根目录', { exact: true }).fill(root);
    await page.getByLabel('游戏目录', { exact: true }).fill(game);
    await page.getByLabel('Mod 目录', { exact: true }).fill(mods);
    if(gameId==='endfield')await app.evaluate(()=>{globalThis.kmmRuntimeInstalled=false;});
    await captureChanges();
    await page.getByRole('button', { name: `下载并部署 ${importer}`, exact: true }).click();
    await page.getByText('文件部署完成', { exact: true }).waitFor({ timeout: 60000 });
    await settingsChanged(gameId);
    if(gameId==='endfield'){
      await page.getByText('运行库待确认；尚不能确认 Launcher 可启动。',{exact:true}).waitFor();
      await page.getByText('官方组件与路径已部署并保存。请先安装或确认 Visual C++ x64 运行库。',{exact:true}).waitFor();
      assert.equal((await page.evaluate(()=>window.kmm.deploymentProgress())).value.stage,'complete');
      await page.screenshot({path:path.join(run,'endfield-runtime-missing.png')});
      await app.evaluate(()=>{globalThis.kmmRuntimeInstalled=true;});await page.getByRole('button',{name:'检查运行库',exact:true}).click();
      await page.getByText('运行库已检测；可通过 XXMI 检查游戏加载。',{exact:true}).waitFor();
    }
    await page.locator('.deployment-result').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(run, `${gameId}-deployment.png`) });
    assert.equal(await page.getByText('检测到组件', { exact: true }).count(), 1);
    const replacement = path.join(run, gameId, 'Changed Mods');
    await page.getByLabel('Mod 目录', { exact: true }).fill(replacement);
    await captureChanges();
    await page.getByRole('button', { name: '同步路径到 XXMI', exact: true }).click();
    await page.getByText('路径已同步到 XXMI 并保存。', { exact: false }).waitFor();
    await settingsChanged(gameId);
    const config = JSON.parse(await fs.readFile(path.join(root, 'XXMI Launcher Config.json'), 'utf8'));
    assert.equal(config.Importers[importer].Importer.d3dx_ini.core.Include.include_recursive, replacement);
    await page.locator('.detection').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(run, `${gameId}-synced.png`) });
    results.push({ gameId, root, game, mods: replacement });
  }
  const staleSync=(await page.evaluate(()=>window.kmm.readSettings())).value;
  const externalSync=structuredClone(staleSync);externalSync.games.zzz.modsDirectory=path.join(run,'External ZZZ Mods');await fs.mkdir(externalSync.games.zzz.modsDirectory,{recursive:true});externalSync.desktop={marketUrl:'https://example.com/from-other-window',updateUrl:'',closeToTray:true};
  assert.equal((await page.evaluate(settings=>window.kmm.saveSettings(settings),externalSync)).ok,true);
  const syncResult=await page.evaluate(settings=>window.kmm.syncPaths(settings),staleSync);assert.equal(syncResult.ok,true,JSON.stringify(syncResult));assert.deepEqual(syncResult.value.settings.games.zzz,externalSync.games.zzz);assert.deepEqual(syncResult.value.settings.desktop,externalSync.desktop);await fs.stat(path.join(syncResult.value.backupDirectory,'d3dx.ini'));
  await page.getByLabel('当前游戏',{exact:true}).selectOption('zzz');await page.waitForFunction(()=>document.querySelector('.current-game-select').value==='zzz'&&!document.querySelector('.current-game-select').disabled);
  const retryRoot=path.join(run,'Failure Then Retry XXMI');const retryMods=path.join(run,'Failure Then Retry Mods');
  await page.getByLabel('XXMI 安装根目录',{exact:true}).fill(retryRoot);await page.getByLabel('游戏目录',{exact:true}).fill(results[0].game);await page.getByLabel('Mod 目录',{exact:true}).fill(retryMods);
  await app.evaluate((_,url)=>{globalThis.kmmFixtureUrl=url;},offlineFixture.url);await page.getByRole('button',{name:'下载并部署 ZZMI',exact:true}).click();
  await page.getByRole('alert').first().waitFor();assert.match(await page.getByRole('alert').first().innerText(),/HTTP 503/);assert.equal((await page.evaluate(()=>window.kmm.deploymentProgress())).value.stage,'error');await fs.stat(retryRoot).then(()=>assert.fail('Failed request wrote installation root'),error=>assert.equal(error.code,'ENOENT'));
  assert.equal((await page.evaluate(()=>window.kmm.readSettings())).value.games.zzz.xxmiRoot,staleSync.games.zzz.xxmiRoot);await page.screenshot({path:path.join(run,'http-failure.png')});
  const staleDeploy=(await page.evaluate(()=>window.kmm.readSettings())).value;staleDeploy.selectedGame='zzz';staleDeploy.games.zzz={xxmiRoot:retryRoot,gameDirectory:results[0].game,modsDirectory:retryMods};
  const externalDeploy=(await page.evaluate(()=>window.kmm.readSettings())).value;externalDeploy.games.endfield.modsDirectory=path.join(run,'External End Mods');await fs.mkdir(externalDeploy.games.endfield.modsDirectory,{recursive:true});externalDeploy.desktop={...externalDeploy.desktop,updateUrl:'https://example.com/latest-releases'};assert.equal((await page.evaluate(settings=>window.kmm.saveSettings(settings),externalDeploy)).ok,true);
  await app.evaluate((_,url)=>{globalThis.kmmFixtureUrl=url;},fixture.url);
  const deployResult=await page.evaluate(settings=>window.kmm.deploy(settings),staleDeploy);assert.equal(deployResult.ok,true,JSON.stringify(deployResult));assert.equal(deployResult.value.ready,true);assert.deepEqual(deployResult.value.settings.games.endfield,externalDeploy.games.endfield);assert.deepEqual(deployResult.value.settings.desktop,externalDeploy.desktop);
  const persisted=(await page.evaluate(()=>window.kmm.readSettings())).value;assert.deepEqual(persisted,deployResult.value.settings);await fs.stat(path.join(retryRoot,'ZZMI','d3d11.dll'));
  results[0]={...results[0],root:retryRoot,mods:retryMods};results[1].mods=externalDeploy.games.endfield.modsDirectory;
  await page.getByRole('button',{name:'检测已有安装',exact:true}).click();await page.getByText('检测到组件',{exact:true}).waitFor();assert.equal(await page.getByLabel('XXMI 安装根目录',{exact:true}).inputValue(),retryRoot);
  await page.getByLabel('当前游戏',{exact:true}).selectOption('endfield');await page.waitForFunction(()=>document.querySelector('.current-game-select').value==='endfield'&&!document.querySelector('.current-game-select').disabled);
  await app.close(); app = null; page = await launch();
  assert.equal(await page.getByLabel('当前游戏',{exact:true}).inputValue(),'endfield');
  assert.equal(await page.getByLabel('Mod 目录', { exact: true }).inputValue(), results[1].mods);
  await page.getByLabel('当前游戏',{exact:true}).selectOption('zzz');await page.waitForFunction(()=>document.querySelector('.current-game-select').value==='zzz'&&!document.querySelector('.current-game-select').disabled);
  assert.equal(await page.getByLabel('Mod 目录', { exact: true }).inputValue(), results[0].mods);
  assert.deepEqual(pageErrors, []);
  const report = { result: 'PASS', headedElectron: true, fixtureHttp: true, runtimeMocked: true, noGameExecuted: true, restartPersisted: true,missingRuntimeUiUnready:true,httpFailureNoSuccess:true,staleSyncAndDeployPreserveOtherGameAndDesktop:true,deploymentAndSyncEventsSettingsChanged:true,pageErrors, run, results, requests: fixture.requestCount(),offlineRequests:offlineFixture.requestCount() };
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}catch(error){if(app){for(const [index,page]of app.windows().entries()){await page.screenshot({path:path.join(run,`failure-${index}.png`)}).catch(()=>{});await fs.writeFile(path.join(run,`failure-${index}.txt`),await page.locator('body').innerText().catch(()=>''));}}await fs.writeFile(path.join(run,'failure.json'),JSON.stringify({run,pageErrors,error:error.stack||String(error)},null,2));throw error;
} finally { if (app) await app.close(); await fixture.close();await offlineFixture.close(); }

