import {deriveInventory,inspectRuntimeIPC} from './api-inventory.mjs';
import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

// Real headed windows, real IPC and isolated files. Delays only make queue ordering reproducible.
const packaged = process.argv.includes('--packaged');
const reportArgument = process.argv.find(argument => argument.startsWith('--package-report='));
const packageReport = packaged ? JSON.parse(await fs.readFile(reportArgument?.slice('--package-report='.length) || process.env.KMM_PACKAGE_REPORT || 'release/package-report.json', 'utf8')) : null;
const parent = path.resolve(process.env.KMM_SMOKE_DIR || '.run-data/framework-smoke');
assert.ok(parent.startsWith(path.resolve('.run-data') + path.sep), 'Framework evidence must stay in .run-data');
await fs.mkdir(parent, {recursive:true});
const run = await fs.mkdtemp(path.join(parent, 'run-'));
const data = path.join(run, 'data');
const checks = [];
const errors = [];
let application;
let secondary;
let gate;
let runtimeEvidence;
async function write(file, bytes) { await fs.mkdir(path.dirname(file), {recursive:true}); await fs.writeFile(file, bytes); }
const settings = {version:1, selectedGame:'zzz', desktop:{closeToTray:true,marketUrl:'',updateUrl:''}, games:{}};
for (const [game, importer, character] of [['zzz','ZZMI','安比'], ['endfield','EFMI','佩丽卡']]) {
  const root = path.join(run, game, 'XXMI');
  const mods = path.join(root, importer, 'Mods');
  const gameDirectory = path.join(run, game, 'Game');
  settings.games[game] = {xxmiRoot:root, modsDirectory:mods, gameDirectory};
  await write(path.join(root, 'Resources', 'Bin', 'XXMI Launcher.exe'), 'fixture; never execute');
  await fs.mkdir(gameDirectory, {recursive:true});
  await write(path.join(root, 'XXMI Launcher Config.json'), JSON.stringify({Importers:{[importer]:{Importer:{importer_folder:importer+'/',game_folder:gameDirectory}}}}));
  await write(path.join(root, importer, 'd3dx.ini'), '[Include]\ninclude_recursive=Mods\nexclude_recursive=DISABLED*\n');
  await write(path.join(mods, '角色', character, 'FrameworkMod', 'main.ini'), '[TextureOverrideFramework]\nhash=01234567');
}
await write(path.join(data, 'settings.json'), JSON.stringify(settings));
const env = {...process.env};
for (const name of ['ELECTRON_RUN_AS_NODE','KMM_DEV_URL','USE_SYSTEM_7Z']) delete env[name];
const launchOptions = profile => ({...(packaged ? {executablePath:packageReport.executable,args:[],cwd:run} : {args:['.']}),env:{...env,KMM_DATA_DIR:profile}});
async function ready(page) {
  await page.getByRole('heading', {name:/^Mod 库/}).waitFor();
  await page.waitForFunction(() => document.querySelector('.current-game-select') && !document.querySelector('.current-game-select').disabled);
}
async function launch(profile=data) {
  const app = await electron.launch(launchOptions(profile));
  try {
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await app.evaluate(async ({BrowserWindow}) => {
    const win = BrowserWindow.getAllWindows()[0];
    globalThis.frameworkMainId=win.id;
    for(let count=0; count<100 && !win.isVisible(); count++) await new Promise(resolve=>setTimeout(resolve,50));
    assertVisible(win);
    function assertVisible(win) { if(!win.isVisible()) throw new Error('Main window never became visible'); }
  });
  return {app,page};
  } catch(error) { await app.close().catch(()=>{}); throw error; }
}
async function runtime() {
  return application.evaluate(({app}) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
    const {window,floatingWindow,tray} = require(app.getAppPath()+'/dist/main/index.js').desktopRuntime();
    return {visible:window.isVisible(),minimized:window.isMinimized(),floating:!!floatingWindow,tray:!!tray&&!tray.isDestroyed()};
  });
}
async function waitRuntime(expected) {
  for(let count=0;count<100;count++) {
    const state=await runtime();
    if(Object.entries(expected).every(([name,value])=>state[name]===value))return state;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('Window state did not settle: '+JSON.stringify({expected,actual:await runtime()}));
}
async function menu(label) {
  await application.evaluate(({app}, label) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
    const item = require(app.getAppPath()+'/dist/main/index.js').desktopRuntime().trayMenu.items.find(item=>item.label===label);
    if(!item) throw new Error('Tray menu missing '+label);
    item.click(item);
  }, label);
}
async function value(page, method, ...args) {
  const result = await page.evaluate(async ({method,args}) => window.kmm[method](...args), {method,args});
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
try {
  let launched = await launch(); application=launched.app; let page=launched.page;
  assert.equal((await runtime()).tray,true);
  const security = await application.evaluate(({BrowserWindow}) => {
    const preferences = BrowserWindow.fromId(globalThis.frameworkMainId).webContents.getLastWebPreferences();
    return {sandbox:preferences.sandbox,contextIsolation:preferences.contextIsolation,nodeIntegration:preferences.nodeIntegration};
  });
  assert.deepEqual(security, {sandbox:true,contextIsolation:true,nodeIntegration:false});
  assert.equal(await page.evaluate(()=>typeof window.require),'undefined');
  checks.push('visible React main window, sandbox, context isolation, native tray');
  if(packaged) {
    runtimeEvidence=await application.evaluate(({app})=>{
      const require=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
      const fs=process.getBuiltinModule('fs');const path=process.getBuiltinModule('path');const crypto=process.getBuiltinModule('crypto');
      const files={helper:path.join(app.getAppPath(),'assets','refresh-helper.ps1'),portraits:path.join(app.getAppPath(),'assets','character-covers','manifest.json'),yauzl:require.resolve('yauzl'),pend:require.resolve('pend'),sevenPackage:require.resolve('7zip-bin-full'),sevenExe:require('7zip-bin-full').path7z};
      files.sevenDll=path.join(path.dirname(files.sevenExe),'7z.dll');
      const hashes=Object.fromEntries(Object.entries(files).map(([name,file])=>[name,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
      const portraits=JSON.parse(fs.readFileSync(files.portraits,'utf8'));for(const entry of portraits.entries)fs.statSync(path.join(app.getAppPath(),'assets','character-covers',entry.file));
      return {appPath:app.getAppPath(),executable:process.execPath,cwd:process.cwd(),files,hashes,portraitCount:portraits.entries.length};
    });
    for(const file of [runtimeEvidence.appPath,runtimeEvidence.executable,...Object.values(runtimeEvidence.files)]) {
      const relative=path.relative(packageReport.directory,file);
      assert.ok(relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),'Runtime file outside portable package: '+file);
    }
    assert.equal(runtimeEvidence.cwd,run);assert.equal(runtimeEvidence.portraitCount,88);
    await write(path.join(run,'runtime-paths.json'),JSON.stringify(runtimeEvidence,null,2));
    checks.push('package launches with isolated cwd; actual dependencies, complete 7-Zip, helper and 88 portrait files resolve inside portable directory');
  }

  // TS AST-derived source contract compared with actual compiled runtime and live bridge.
  const expected=await deriveInventory();
  const compiled=await application.evaluate(({app})=>{const fs=process.getBuiltinModule('fs');return {main:fs.readFileSync(app.getAppPath()+'/dist/main/index.js','utf8'),preload:fs.readFileSync(app.getAppPath()+'/dist/preload/index.js','utf8')};});
  const inventory=inspectRuntimeIPC(compiled.main,compiled.preload);
  assert.deepEqual(inventory.handlers,expected.methods.map(method=>method.channel).sort());assert.deepEqual(inventory.invokes,inventory.handlers);
  assert.deepEqual(await page.evaluate(()=>Object.keys(window.kmm).sort()),[...expected.methods.map(method=>method.method),...expected.events.map(event=>event.method)].sort());
  checks.push(expected.counts.asynchronousMethods+' IPC handlers match typed preload invokes and live bridge; event subscription included');

  const library = await value(page,'scanMods','zzz');
  const mod = library.mods[0];
  await page.evaluate(()=>{window.frameworkEvents=[];window.frameworkUnsubscribe=window.kmm.onDesktopChange(event=>window.frameworkEvents.push(event));});
  await application.evaluate(({app}) => {
    const require = process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');
    const prototype = require(app.getAppPath()+'/dist/main/mods.js').ModService.prototype;
    const original = prototype.operate;
    globalThis.frameworkStarted=false;
    const pause = new Promise(resolve=>{globalThis.frameworkRelease=resolve;});
    prototype.operate=async function(...args) { prototype.operate=original;globalThis.frameworkStarted=true;await pause;return original.apply(this,args); };
  });
  gate=true;
  await page.evaluate(({id,settings}) => {
    window.frameworkPending={};window.frameworkCompleted={};
    for(const [name,promise] of [
      ['operation',window.kmm.operateMod('zzz',id,{kind:'toggle',enabled:false})],
      ['save',window.kmm.saveSettings({...settings,selectedGame:'endfield'})],
      ['read',window.kmm.readSettings()],
      ['inspect',window.kmm.inspect('zzz',settings.games.zzz.xxmiRoot)],
    ]) window.frameworkPending[name]=promise.then(result=>{window.frameworkCompleted[name]=result;return result;});
  },{id:mod.id,settings});
  await application.evaluate(async()=>{for(let count=0;count<100&&!globalThis.frameworkStarted;count++)await new Promise(resolve=>setTimeout(resolve,10));if(!globalThis.frameworkStarted)throw new Error('Queue gate did not start');});
  assert.equal((await value(page,'desktopStatus')).trayAvailable,true,'Desktop status must remain responsive while files wait');
  const progress=await value(page,'deploymentProgress'); assert.equal(typeof progress,'object');
  await page.waitForTimeout(150);
  const early=await page.evaluate(()=>window.frameworkCompleted);
  await write(path.join(run,'queue-before-release.json'),JSON.stringify(early,null,2));
  assert.equal(Object.hasOwn(early,'read'),false,'settings:read overtook queued mutation and settings save');
  assert.equal(Object.hasOwn(early,'inspect'),false,'xxmi:inspect overtook queued file operation');
  await application.evaluate(()=>globalThis.frameworkRelease());gate=false;
  const completed=await page.evaluate(()=>Promise.all(Object.values(window.frameworkPending)));
  for(const result of completed)assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(completed[2].value.selectedGame,'endfield');
  const events=await page.evaluate(()=>window.frameworkEvents);
  assert.deepEqual(events.slice(0,2),[{gameId:'zzz',settingsChanged:false},{gameId:'endfield',settingsChanged:true}]);
  await fs.stat(path.join(settings.games.zzz.modsDirectory,'角色','安比','DISABLED_FrameworkMod','main.ini'));
  checks.push('queued settings/inspection wait behind real file toggle; per-operation broadcasts precede next mutation; status/progress stay responsive');
  await page.evaluate(()=>window.frameworkUnsubscribe());
  const eventCount=events.length;
  await value(page,'selectGame','zzz');
  assert.equal(await page.evaluate(()=>window.frameworkEvents.length),eventCount);
  checks.push('desktop event subscription can be removed');

  const floatingPromise=application.waitForEvent('window');
  await page.getByRole('button',{name:'快速管理浮窗',exact:true}).click();
  const floating=await floatingPromise;
  floating.on('pageerror',error=>errors.push(error.message));
  await floating.getByRole('button',{name:'启用 FrameworkMod',exact:true}).waitFor();
  await floating.getByRole('button',{name:'启用 FrameworkMod',exact:true}).click();
  await floating.getByRole('button',{name:'停用 FrameworkMod',exact:true}).waitFor();
  await fs.stat(path.join(settings.games.zzz.modsDirectory,'角色','安比','FrameworkMod','main.ini'));
  await floating.getByLabel('当前游戏',{exact:true}).selectOption('endfield');
  await page.waitForFunction(()=>document.querySelector('.current-game-select').value==='endfield'&&!document.querySelector('.current-game-select').disabled);
  await floating.getByRole('button',{name:'停用 FrameworkMod',exact:true}).waitFor();
  const currentLibrary=await value(floating,'scanMods','endfield');
  const fixtureRole=currentLibrary.mods.find(mod=>mod.name==='FrameworkMod').metadata.character;
  await page.waitForFunction(name=>{
    const role=[...document.querySelectorAll('.character-open')].find(button=>button.getAttribute('aria-label')==='打开角色：'+name);
    return !!document.querySelector('.gallery-controls')&&[...document.querySelectorAll('.library-actions button')].every(button=>!button.disabled)&&role?.textContent.includes('1 个 Mod · 1 启用');
  },fixtureRole);
  await page.screenshot({path:path.join(run,'main.png')});await floating.screenshot({path:path.join(run,'floating.png')});
  checks.push('visible floating UI physical toggle and shared current game update');

  // Hidden test windows deliberately reuse the production preload but have no trusted host identity.
  const outsider = await application.evaluate(async ({BrowserWindow,app}) => {
    const win = new BrowserWindow({show:false,webPreferences:{preload:app.getAppPath()+'/dist/preload/index.js',sandbox:true,contextIsolation:true,nodeIntegration:false}});
    try { await win.loadURL('about:blank');return await win.webContents.executeJavaScript('window.kmm.readSettings()'); } finally {win.destroy();}
  });
  assert.equal(outsider.ok,false);assert.match(outsider.error,/无权/);
  await page.evaluate(()=>{const frame=document.createElement('iframe');frame.src='about:blank';frame.id='framework-child';document.body.append(frame);});
  await page.waitForFunction(()=>!!document.querySelector('#framework-child')?.contentWindow);
  assert.equal(await page.locator('#framework-child').evaluate(frame=>typeof frame.contentWindow.kmm),'undefined','Production preload is not exposed to child frames');
  const child=await application.evaluate(async({BrowserWindow,ipcMain})=>{
    const contents=BrowserWindow.fromId(globalThis.frameworkMainId).webContents;
    const frame=contents.mainFrame.frames[0];if(!frame)throw new Error('Real child frame missing');
    return ipcMain._invokeHandlers.get('settings:read')({sender:contents,senderFrame:frame});
  });
  assert.equal(child.ok,false);assert.match(child.error,/无权/);
  await page.evaluate(()=>document.querySelector('#framework-child').remove());
  await page.evaluate(()=>{window.open('https://example.invalid/');});
  await page.waitForTimeout(100);assert.equal(application.windows().length,2);
  const originalUrl=page.url();
  const blockedDocument=pathToFileURL(path.join(run,'blocked-document.html')).href;
  await write(path.join(run,'blocked-document.html'),'<!doctype html><title>Local navigation fixture</title>');
  await page.evaluate(url=>{location.href=url;},blockedDocument);
  await page.waitForTimeout(100);assert.equal(page.url(),originalUrl);
  const redirectBlocked=await application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.fromId(globalThis.frameworkMainId);const event={defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};win.webContents.emit('will-redirect',event,'https://example.invalid/',false,true,0,0);return event.defaultPrevented;});
  assert.equal(redirectBlocked,true,'Top-level redirects must be denied');
  const untrustedDocument=await application.evaluate(async({BrowserWindow})=>{const win=BrowserWindow.fromId(globalThis.frameworkMainId);await win.loadURL('about:blank');return win.webContents.executeJavaScript('window.kmm.readSettings()');});
  assert.equal(untrustedDocument.ok,false);assert.match(untrustedDocument.error,/无权/);
  await application.evaluate(async({BrowserWindow},url)=>{await BrowserWindow.fromId(globalThis.frameworkMainId).loadURL(url);},originalUrl);
  await ready(page);
  assert.equal((await value(page,'readSettings')).selectedGame,'endfield');
  checks.push('unregistered window and changed trusted-window document denied real IPC; child has no bridge and handler rejects event using real child frame; real navigation/popup denied; redirect guard exercised with Electron event');

  const stable={};
  for(const game of ['zzz','endfield']) {
    const entry=(await value(page,'scanMods',game)).mods[0]; stable[game]=entry.id;
    await value(page,'operateMod',game,entry.id,{kind:'rename',name:'FrameworkRenamed'});
    const moved=await value(page,'operateMod',game,entry.id,{kind:'classify',category:'框架验证',character:game==='zzz'?'安比':'佩丽卡',appearance:'测试'});
    assert.equal(moved.mods[0].id,entry.id);
    const covers=await value(page,'characterCovers',game);assert.equal(Object.keys(covers).length,game==='zzz'?57:31);
    const decoded=await page.evaluate(async covers=>Promise.all(Object.values(covers).map(source=>new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth>0&&image.naturalHeight>0);image.onerror=()=>resolve(false);image.src=source;}))),covers);
    assert.ok(decoded.every(Boolean),'All bundled portraits decode in Chromium');
  }
  checks.push('stable IDs after rename/move in both games; all 57+31 local portraits decode through live bridge');

  await application.evaluate(({BrowserWindow})=>BrowserWindow.fromId(globalThis.frameworkMainId).close());
  assert.equal((await runtime()).visible,false);
  await floating.getByRole('button',{name:'打开主窗口',exact:true}).click();assert.equal((await runtime()).visible,true);
  await application.evaluate(({BrowserWindow})=>{BrowserWindow.fromId(globalThis.frameworkMainId).minimize();});
  await menu('显示主窗口');await waitRuntime({visible:true,minimized:false});assert.equal((await runtime()).minimized,false);
  const executable=await application.evaluate(()=>process.execPath);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.fromId(globalThis.frameworkMainId).close());
  await promisify(execFile)(executable,packaged?[]:['.'],{env:{...env,KMM_DATA_DIR:data},cwd:packaged?run:process.cwd(),windowsHide:true,timeout:10000});
  assert.equal((await runtime()).visible,true);assert.equal(application.windows().length,2);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.fromId(globalThis.frameworkMainId).minimize());
  await waitRuntime({minimized:true});
  assert.equal((await runtime()).minimized,true);
  await promisify(execFile)(executable,packaged?[]:['.'],{env:{...env,KMM_DATA_DIR:data},cwd:packaged?run:process.cwd(),windowsHide:true,timeout:10000});
  await waitRuntime({visible:true,minimized:false});assert.equal((await runtime()).minimized,false);assert.equal((await runtime()).visible,true);
  const otherData=path.join(run,'other-data');
  await write(path.join(otherData,'settings.json'),JSON.stringify({...settings,selectedGame:'zzz'}));
  const second=await launch(otherData);secondary=second.app;
  assert.equal((await value(second.page,'readSettings')).selectedGame,'zzz');
  assert.equal((await value(page,'readSettings')).selectedGame,'endfield');
  await secondary.close();secondary=null;
  checks.push('close hides main; floating/tray restore minimized/hidden main; same-profile singleton; independent profile visible with separate settings');

  const quitEvent=application.waitForEvent('close');await menu('退出 Kiriu Mod Manager');await quitEvent;application=null;
  launched=await launch();application=launched.app;page=launched.page;
  const reloaded=await value(page,'readSettings');assert.equal(reloaded.selectedGame,'endfield');assert.deepEqual(reloaded.games,settings.games);
  for(const game of ['zzz','endfield'])assert.equal((await value(page,'scanMods',game)).mods[0].id,stable[game]);
  assert.equal((await runtime()).floating,false);
  const changed=await value(page,'saveSettings',{...reloaded,desktop:{...reloaded.desktop,closeToTray:false}});assert.equal(changed.desktop.closeToTray,false);
  const closeEvent=application.waitForEvent('close');await application.evaluate(({BrowserWindow})=>BrowserWindow.fromId(globalThis.frameworkMainId).close());await closeEvent;application=null;
  checks.push('tray quits process and floating window; settings and stable IDs persist restart; closeToTray=false exits process');
  assert.deepEqual(errors,[]);
  const report={result:'PASS',run,data,packaged,executable:packageReport?.executable||'source Electron',runtimeEvidence,headedElectron:true,checks,pageErrors:errors,realGameOrXXMIExecuted:false,notVerified:['real game loading and refresh','human acceptance',...(packaged?[]:['portable package runtime; source stage only'])]};
  await write(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} catch(error) {
  if(application) {
    if(gate)await application.evaluate(()=>globalThis.frameworkRelease?.()).catch(()=>{});
    for(const [index,page] of application.windows().entries())await page.screenshot({path:path.join(run,`failure-${index}.png`)}).catch(()=>{});
  }
  await write(path.join(run,'failure.json'),JSON.stringify({result:'FAIL',run,checks,pageErrors:errors,error:error.stack||String(error)},null,2));
  console.error('Framework evidence: '+run);throw error;
} finally {if(secondary)await secondary.close().catch(()=>{});if(application)await application.close().catch(()=>{});}
