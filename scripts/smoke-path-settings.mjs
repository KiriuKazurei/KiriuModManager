import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const packaged=process.argv.includes('--packaged');
const reportArgument=process.argv.find(argument=>argument.startsWith('--package-report='));
const packageReport=packaged?JSON.parse(await fs.readFile(reportArgument?.slice('--package-report='.length)||'release/package-report.json','utf8')):null;
const parent=path.resolve('.run-data/path-settings-smoke');
await fs.mkdir(parent,{recursive:true});
const run=await fs.mkdtemp(path.join(parent,'run-')),data=path.join(run,'data');
const settings={version:1,selectedGame:'zzz',games:{}},fixtures={},checks=[],errors=[];
async function write(file,text){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
for(const game of ['zzz','endfield']){
  const root=path.join(run,game,'XXMI'),gameDirectory=path.join(run,game,'Game'),modsDirectory=path.join(run,game,'Mods');
  const importer=game==='zzz'?'ZZMI':'EFMI',name=game==='zzz'?'ZenlessZoneZero.exe':'Endfield.exe';
  const launcher=path.join(root,'Resources','Bin','XXMI Launcher.exe'),executable=path.join(gameDirectory,name);
  await write(launcher,'fixture; never execute');await write(executable,'fixture; never execute');
  await write(path.join(root,importer,'d3dx.ini'),'[Include]\ninclude_recursive=Mods');
  await write(path.join(root,'XXMI Launcher Config.json'),JSON.stringify({Importers:{[importer]:{Importer:{game_folder:gameDirectory,importer_folder:importer}}}}));
  await fs.mkdir(modsDirectory,{recursive:true});
  settings.games[game]={xxmiRoot:launcher,gameDirectory:executable,modsDirectory};
  fixtures[game]={root,gameDirectory,modsDirectory,launcher,executable};
}
const savedFile=path.join(data,'settings.json');await write(savedFile,JSON.stringify(settings));
const unrelatedFile=path.join(run,'notes.txt');await write(unrelatedFile,'keep');
const env={...process.env,KMM_DATA_DIR:data};
delete env.ELECTRON_RUN_AS_NODE;delete env.KMM_DEV_URL;delete env.KMM_UPDATE_JOB;
let app,page;
async function launch(){
  app=await electron.launch({...packaged?{executablePath:packageReport.executable,args:[],cwd:packageReport.directory}:{args:['.'],cwd:process.cwd()},env});
  page=await app.firstWindow();page.setDefaultTimeout(20000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.locator('.sidebar').waitFor();
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(window=>window.isVisible())),true);
  assert.equal(await app.evaluate(({app})=>app.isPackaged),packaged);
  assert.equal(await app.evaluate(({app})=>app.getVersion()),packageReport?.version||JSON.parse(await fs.readFile('package.json','utf8')).version);
  await page.locator('.sidebar').getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('heading',{name:'路径设置',exact:true}).waitFor();
}
async function screenshot(name){
  const cdp=await page.context().newCDPSession(page);
  try {const shot=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:false,captureBeyondViewport:false});await fs.writeFile(path.join(run,name+'.png'),Buffer.from(shot.data,'base64'));}
  finally {await cdp.detach();}
}
async function chooseGame(game){
  await page.getByLabel('当前游戏',{exact:true}).selectOption(game);
  await page.waitForFunction(game=>document.querySelector('.current-game-select').value===game&&!document.querySelector('.current-game-select').disabled,game);
}
try {
  await launch();
  assert.equal(await page.locator('.path-repair').evaluate(node=>node.open),false);
  assert.equal(await page.getByRole('heading',{name:'游戏环境',exact:true}).count(),0);
  assert.equal(await page.locator('#xxmiRoot-hint').isVisible(),true);
  assert.equal(await page.locator('#gameDirectory-hint').isVisible(),true);
  for(const game of ['zzz','endfield']){
    await chooseGame(game);const f=fixtures[game];
    assert.equal(await page.getByRole('button',{name:'保存配置',exact:true}).isEnabled(),true);
    await page.getByRole('button',{name:'检测已有安装',exact:true}).click();
    await page.getByText('检测到组件',{exact:true}).waitFor();
    await page.getByRole('button',{name:'保存配置',exact:true}).click();
    await page.getByText('配置已保存，已将输入路径规范为目录。',{exact:true}).waitFor();
    assert.equal(await page.locator('#xxmiRoot').inputValue(),f.root);
    assert.equal(await page.locator('#gameDirectory').inputValue(),f.gameDirectory);
    const disk=JSON.parse(await fs.readFile(savedFile,'utf8'));
    assert.deepEqual(disk.games[game],{xxmiRoot:f.root,gameDirectory:f.gameDirectory,modsDirectory:f.modsDirectory});
    checks.push(game+': legacy EXE paths detected, explicit save normalizes and persists directories');
  }
  await chooseGame('zzz');
  const before=await fs.readFile(savedFile);
  await page.locator('#xxmiRoot').fill(unrelatedFile);
  await page.getByRole('button',{name:'保存配置',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'当前路径是文件'}).waitFor();
  assert.deepEqual(await fs.readFile(savedFile),before);
  assert.equal(await page.locator('#xxmiRoot').inputValue(),unrelatedFile);
  checks.push('file input rejected through production IPC; saved bytes and failed draft retained');
  await page.locator('#xxmiRoot').fill(fixtures.zzz.root);
  await page.locator('#modsDirectory').fill(path.join(run,'unsaved-mod-draft'));
  await page.locator('.path-repair>summary').focus();
  await page.locator('.path-repair>summary').press('Enter');
  const repair=page.getByRole('region',{name:'路径检查与修复',exact:true});
  await repair.getByRole('heading',{name:'已保存路径状态',exact:true}).waitFor();
  await repair.getByRole('heading',{name:'路径检查通过',exact:true}).waitFor();
  assert.ok((await repair.innerText()).includes(fixtures.zzz.modsDirectory));
  assert.equal((await repair.innerText()).includes('unsaved-mod-draft'),false);
  assert.equal(await page.locator('#modsDirectory').inputValue(),path.join(run,'unsaved-mod-draft'));
  assert.deepEqual(await fs.readFile(savedFile),before);
  await page.locator('.path-repair').scrollIntoViewIfNeeded();await screenshot('checks-and-repair');
  checks.push('repair embedded under path settings, reads saved paths and preserves unsaved draft');
  await app.close();app=null;await launch();
  assert.equal(await page.locator('#xxmiRoot').inputValue(),fixtures.zzz.root);
  assert.equal(await page.locator('#gameDirectory').inputValue(),fixtures.zzz.gameDirectory);
  assert.equal(await page.locator('.path-repair').evaluate(node=>node.open),false);
  await page.locator('#xxmiRoot').scrollIntoViewIfNeeded();await screenshot('normalized-paths');
  checks.push('visible source window restart restores normalized paths and collapsed repair tools');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.getByRole('button',{name:'切换到夜间',exact:true}).click();
  await page.getByRole('button',{name:'切换到日间',exact:true}).waitFor();
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,820));
  await page.waitForFunction(()=>window.innerWidth<=900);
  await page.locator('#gameDirectory').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#xxmiRoot-hint').isVisible(),true);
  assert.equal(await page.locator('#gameDirectory-hint').isVisible(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
  await screenshot('dark-paths-900');
  checks.push('keyboard-operated repair disclosure and visible hints in light/dark themes, no horizontal overflow at 900px');
  assert.deepEqual(errors,[]);
  await write(path.join(run,'report.json'),JSON.stringify({ok:true,checks,errors},null,2));
  console.log(JSON.stringify({ok:true,run,checks},null,2));
} catch(error) {
  if(page){await screenshot('failed').catch(()=>{});await write(path.join(run,'failed.html'),await page.content().catch(()=>''));}
  await write(path.join(run,'report.json'),JSON.stringify({ok:false,checks,errors,error:error.stack},null,2));
  console.error(error);process.exitCode=1;
} finally {if(app)await app.close().catch(()=>{});}
