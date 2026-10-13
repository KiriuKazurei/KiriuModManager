import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// This is a headed Electron launch. No game or real XXMI installation is touched.
const evidence = path.resolve(process.env.KMM_SMOKE_DIR || '.run-data/smoke');
await fs.mkdir(evidence, { recursive: true });
const run = await fs.mkdtemp(path.join(evidence, 'run-'));
const root = path.join(run, 'XXMI'); const game = path.join(run, 'Game');
const data = path.join(run, 'data'); const mods = path.join(root, 'ZZMI', 'Mods');
await fs.mkdir(path.join(root, 'Resources', 'Bin'), { recursive: true });
await fs.mkdir(mods, { recursive: true }); await fs.mkdir(game);
await fs.writeFile(path.join(root, 'Resources', 'Bin', 'XXMI Launcher.exe'), 'fixture only; never execute');
await fs.writeFile(path.join(root, 'XXMI Launcher Config.json'), JSON.stringify({ Launcher: { enabled_importers: ['ZZMI', 'EFMI'] }, Importers: { ZZMI: { Importer: { importer_folder: 'ZZMI/', game_folder: game } }, EFMI: { Importer: { importer_folder: 'EFMI/', game_folder: '' } } } }));
await fs.writeFile(path.join(root, 'ZZMI', 'd3dx.ini'), '[Include]\ninclude_recursive = Mods\nexclude_recursive = DISABLED*\n');
const before = await fs.readFile(path.join(root, 'XXMI Launcher Config.json'));
const env = { ...process.env, KMM_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE; delete env.KMM_DEV_URL;
let app;
const errors = [];
async function launch() {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '路径与加载器', exact: true }).waitFor();
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const deadline = Date.now() + 10000;
    while (!win.isVisible() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    if (!win.isVisible()) throw new Error('Electron window did not become visible');
  });
  return page;
}
try {
  let page = await launch();
  const windowState = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; const prefs = win.webContents.getLastWebPreferences();
    return { visible: win.isVisible(), bounds: win.getBounds(), contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, sandbox: prefs.sandbox };
  });
  assert.equal(windowState.visible, true); assert.equal(windowState.contextIsolation, true); assert.equal(windowState.nodeIntegration, false); assert.equal(windowState.sandbox, true);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  await page.getByLabel('XXMI 安装根目录', { exact: true }).fill(root);
  await page.getByRole('button', { name: '检测已有安装', exact: true }).click();
  await page.getByText('检测到组件', { exact: true }).waitFor();
  await page.getByRole('button', { name: '使用识别的游戏与 Mod 路径', exact: true }).click();
  assert.equal(await page.getByLabel('Mod 目录', { exact: true }).inputValue(), mods);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存，重启后会恢复当前游戏和路径。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(run, 'zzz.png') });
  await page.getByLabel('当前游戏',{exact:true}).selectOption('endfield');await page.waitForFunction(()=>document.querySelector('.current-game-select').value==='endfield'&&!document.querySelector('.current-game-select').disabled);
  assert.equal(await page.getByLabel('XXMI 安装根目录', { exact: true }).inputValue(), '');
  await page.getByLabel('XXMI 安装根目录', { exact: true }).fill(root);
  await page.getByRole('button', { name: '检测已有安装', exact: true }).click();
  await page.getByText('未安装 / 不完整', { exact: true }).waitFor();
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await page.getByText('配置已保存，重启后会恢复当前游戏和路径。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(run, 'endfield-uninstalled.png') });
  await app.close(); app = null;
  page = await launch();
  assert.equal(await page.getByLabel('当前游戏',{exact:true}).inputValue(),'endfield');
  assert.equal(await page.getByLabel('XXMI 安装根目录', { exact: true }).inputValue(), root);
  await page.getByLabel('当前游戏',{exact:true}).selectOption('zzz');await page.waitForFunction(()=>document.querySelector('.current-game-select').value==='zzz'&&!document.querySelector('.current-game-select').disabled);
  assert.equal(await page.getByLabel('游戏目录', { exact: true }).inputValue(), game);
  assert.equal(await page.getByLabel('Mod 目录', { exact: true }).inputValue(), mods);
  await page.screenshot({ path: path.join(run, 'restart.png') });
  // The floating window has no path editor: its production bridge is used by the
  // privileged driver to model another trusted window saving new configuration.
  async function chooseGame(id){await page.getByLabel('当前游戏',{exact:true}).selectOption(id);await page.waitForFunction(id=>document.querySelector('.current-game-select').value===id&&!document.querySelector('.current-game-select').disabled,id);}
  await chooseGame('endfield');
  const endDraft=path.join(run,'Unsaved End Game');await page.getByLabel('游戏目录',{exact:true}).fill(endDraft);
  await page.getByRole('button',{name:'Mod 库',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('.current-game-select').disabled);
  await page.getByRole('button',{name:'设置',exact:true}).click();assert.equal(await page.getByLabel('游戏目录',{exact:true}).inputValue(),endDraft);
  await chooseGame('zzz');
  await page.getByRole('button',{name:'检测已有安装',exact:true}).click();await page.getByText('检测到组件',{exact:true}).waitFor();
  const zzzDraft=path.join(run,'Unsaved ZZZ Game');await page.getByLabel('游戏目录',{exact:true}).fill(zzzDraft);
  const localMarket='https://example.com/local/{gameId}';await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByLabel('Mod 网页地址',{exact:true}).fill(localMarket);await page.getByRole('button',{name:'设置',exact:true}).click();
  const floatPromise=app.waitForEvent('window');await page.getByRole('button',{name:'快速管理浮窗',exact:true}).click();const floating=await floatPromise;await floating.getByLabel('搜索 Mod',{exact:true}).waitFor();
  const external=(await page.evaluate(()=>window.kmm.readSettings())).value;
  external.games.zzz.xxmiRoot=path.join(run,'External ZZMI');external.games.zzz.modsDirectory=path.join(run,'External ZZZ Mods');
  external.games.endfield={xxmiRoot:path.join(run,'External EFMI'),gameDirectory:path.join(run,'External End Game'),modsDirectory:path.join(run,'External End Mods')};
  external.desktop={marketUrl:'https://example.com/external',updateUrl:'https://example.com/external-releases',closeToTray:false};
  for(const fields of Object.values(external.games))await fs.mkdir(fields.modsDirectory,{recursive:true});
  const externalSave=await floating.evaluate(settings=>window.kmm.saveSettings(settings),external);assert.equal(externalSave.ok,true);
  await page.waitForFunction(({root,mods,url})=>document.querySelector('#xxmiRoot').value===root&&document.querySelector('#modsDirectory').value===mods&&document.querySelector('#updateUrl').value===url,{root:external.games.zzz.xxmiRoot,mods:external.games.zzz.modsDirectory,url:external.desktop.updateUrl});
  await page.getByText('尚未检测',{exact:true}).waitFor();assert.equal(await page.getByLabel('游戏目录',{exact:true}).inputValue(),zzzDraft);assert.equal(await page.getByLabel('Mod 网页地址',{exact:true}).inputValue(),localMarket);assert.equal(await page.getByLabel('关闭主窗口时隐藏到托盘',{exact:true}).isChecked(),false);
  await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByText('配置已保存，重启后会恢复当前游戏和路径。',{exact:true}).waitFor();
  let current=(await page.evaluate(()=>window.kmm.readSettings())).value;
  assert.equal(current.games.zzz.gameDirectory,zzzDraft);assert.equal(current.games.zzz.modsDirectory,external.games.zzz.modsDirectory);assert.deepEqual(current.games.endfield,external.games.endfield);assert.deepEqual(current.desktop,external.desktop);
  await app.evaluate(({ipcMain})=>{globalThis.kmmGameChannels=[];for(const channel of ['desktop:game','settings:save']){const original=ipcMain._invokeHandlers.get(channel);ipcMain._invokeHandlers.set(channel,(...args)=>{globalThis.kmmGameChannels.push(channel);return original(...args);});}});
  await chooseGame('endfield');assert.deepEqual(await app.evaluate(()=>globalThis.kmmGameChannels),['desktop:game']);
  assert.equal(await page.getByLabel('游戏目录',{exact:true}).inputValue(),endDraft);assert.equal(await page.getByLabel('XXMI 安装根目录',{exact:true}).inputValue(),external.games.endfield.xxmiRoot);
  await page.screenshot({path:path.join(run,'external-update-keeps-drafts.png')});
  await page.getByRole('button',{name:'保存配置',exact:true}).click();await page.getByText('配置已保存，重启后会恢复当前游戏和路径。',{exact:true}).waitFor();
  const afterEnd=(await page.evaluate(()=>window.kmm.readSettings())).value;assert.equal(afterEnd.games.endfield.gameDirectory,endDraft);assert.deepEqual(afterEnd.games.zzz,current.games.zzz);
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'保存桌面设置',exact:true}).click();await page.getByText('桌面与网页入口已保存。',{exact:true}).waitFor();
  current=(await page.evaluate(()=>window.kmm.readSettings())).value;assert.deepEqual(current.desktop,{...external.desktop,marketUrl:localMarket});assert.deepEqual(current.games,afterEnd.games);
  await app.close();app=null;page=await launch();
  assert.equal(await page.getByLabel('当前游戏',{exact:true}).inputValue(),'endfield');assert.equal(await page.getByLabel('游戏目录',{exact:true}).inputValue(),endDraft);assert.equal(await page.getByLabel('Mod 网页地址',{exact:true}).inputValue(),localMarket);
  await chooseGame('zzz');assert.equal(await page.getByLabel('游戏目录',{exact:true}).inputValue(),zzzDraft);assert.equal(await page.getByLabel('Mod 目录',{exact:true}).inputValue(),external.games.zzz.modsDirectory);
  await page.screenshot({path:path.join(run,'merged-settings-restart.png')});
  assert.deepEqual(await fs.readFile(path.join(root, 'XXMI Launcher Config.json')), before);
  assert.deepEqual(errors, []);
  const report = { result: 'PASS', headedElectron: true, run, data, windowState, pageErrors: errors, externalSaveViaProductionFloatingBridge:true,floatingHasPathEditor:false,checks: ['React render', 'typed IPC read/save/inspect', 'sandbox isolation', 'ZZMI actual Mods', 'EFMI enabled but missing', 'game path isolation', 'save/restart', 'external configuration unchanged','game drafts survive navigation and saving the other game','external untouched path fields refresh without erasing dirty fields','old-root inspection cleared','current-game save preserves other saved paths and desktop preferences','desktop dirty URL merges with external untouched preferences','App dropdown uses atomic desktop:game channel','merged settings persist restart'] };
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { if (app) await app.close(); }

