import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{probeCompatibilityTarget,sealCompatibilityEvidence}=require('../src/main/compatibility.ts');
const parent=path.resolve('.run-data/process-compatibility-smoke');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-')),data=path.join(run,'data'),checks=[],errors=[],fixtures={};let app,page;
const processMode=process.argv.includes('--process');
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2));};
async function command(name,exe,args,expected=0){const child=spawn(exe,args,{cwd:process.cwd(),windowsHide:true});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);const timer=setTimeout(()=>child.kill(),240000);const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);}).finally(()=>clearTimeout(timer));await write(path.join(run,name+'.log'),JSON.stringify({code,out,err}));assert.equal(code,expected,name+': '+out+err);return out?JSON.parse(out):null;}
const config={schemaVersion:1,machineProfile:'process-smoke-'+path.basename(run),games:{},stableDelayMs:100,pollMs:1000},settings={version:1,selectedGame:'zzz',games:{}};
for(const game of ['zzz','endfield']){
 const base=path.join(run,game),gameRoot=path.join(base,'Game'),xxmiRoot=path.join(base,'XXMI'),importer=game==='zzz'?'ZZMI':'EFMI',exe=path.join(gameRoot,game==='zzz'?'ZenlessZoneZero.exe':'Endfield.exe');
 await write(exe,'controlled hash fixture, never execute');await write(path.join(xxmiRoot,'Resources/Bin/XXMI Launcher.exe'),'controlled hash fixture, never execute');
 for(const name of ['Launcher','XXMI',importer])await write(path.join(xxmiRoot,'Resources/Packages',name,'Manifest.json'),{version:name===importer?'1.2.3':'0.8.8'});
 await write(path.join(xxmiRoot,'XXMI Launcher Config.json'),{Secrets:{token:'process-smoke-secret'},Importers:{[importer]:{Importer:{game_folder:gameRoot,importer_folder:importer}}}});
 await write(path.join(xxmiRoot,importer,'d3dx.ini'),'[Include]\ninclude_recursive = Mods\nexclude_recursive = DISABLED*\n');await write(path.join(xxmiRoot,importer,'Core',importer,'main.ini'),'global $version = 1.23\n');
 const modsDirectory=path.join(xxmiRoot,importer,'Mods');await fs.mkdir(modsDirectory,{recursive:true});settings.games[game]={xxmiRoot,gameDirectory:gameRoot,modsDirectory};config.games[game]={gameRoot,xxmiRoot,channel:'controlled-process-smoke'};fixtures[game]={base,exe,xxmiRoot,importer};
}
await write(path.join(data,'settings.json'),settings);const configFile=path.join(run,'config.json');await write(configFile,config);
async function cli(name,args,expected=0){return command(name,process.execPath,['--import','tsx','dev/compat-sdk/cli/index.ts',...args,'--config',configFile],expected);}
try{
 if(processMode){
  // Compile two harmless stand-ins; these binaries contain no real game or XXMI code.
  const gameSource=path.join(run,'Game.cs'),buildScript=path.join(run,'compile.ps1');await write(gameSource,'public class Game { public static void Main(){System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);} }');
  await write(buildScript,"param($Source,$Output)\n$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition (Get-Content -LiteralPath $Source -Raw) -OutputAssembly $Output -OutputType ConsoleApplication\n");
  for(const game of ['zzz','endfield']){
   const f=fixtures[game],launcher=path.join(f.xxmiRoot,'Resources/Bin/XXMI Launcher.exe'),source=path.join(f.base,'Launcher.cs');await fs.unlink(f.exe);await fs.unlink(launcher);
   await command(game+'-compile-game','powershell.exe',['-NoProfile','-NonInteractive','-File',buildScript,'-Source',gameSource,'-Output',f.exe]);
   await write(source,`public class Launcher {public static void Main(){var s=new System.Diagnostics.ProcessStartInfo(${JSON.stringify(f.exe)});s.UseShellExecute=false;s.CreateNoWindow=true;System.Diagnostics.Process.Start(s);}}`);
   await command(game+'-compile-launcher','powershell.exe',['-NoProfile','-NonInteractive','-File',buildScript,'-Source',source,'-Output',launcher]);
   await cli(game+'-no-opt-in',['run','--game',game,'--suite','process'],2);
   const result=await cli(game+'-process-run',['run','--game',game,'--suite','process','--allow-processes']);assert.equal(result.evidence.verdict,'passed');assert.equal(result.gameCompatibility,'inconclusive');assert.equal(result.recoveryComplete,true);fixtures[game].evidence=result.evidence;
   const exported=JSON.stringify(result.evidence);assert.ok(!exported.includes('process-smoke-secret'));assert.ok(!exported.includes(run));
   checks.push(game+': real CLI executes fixed Launcher stand-in -> owned game child -> restart -> controlled abnormal exit -> process recovery -> empty owned tree; explicit opt-in enforced; no real game/XXMI');
  }
 }
 const version=JSON.parse(await fs.readFile('package.json','utf8')).version;
 for(const game of ['zzz','endfield']){
  const f=fixtures[game];if(!f.evidence){const target=await probeCompatibilityTarget(game,settings.games[game],process.cwd());f.evidence=sealCompatibilityEvidence({schemaVersion:1,kind:'kmm-process-compatibility',scope:'restart-recovery',gameId:game,managerVersion:version,sourceDigest:'d'.repeat(64),runId:'controlled-window-record',testedAt:new Date().toISOString(),target,checks:{local:'passed',restart:'passed',recovery:'passed'},recoveryComplete:true,verdict:'passed'});}
  f.record=path.join(f.base,'compatibility.json');await write(f.record,f.evidence);
 }
 const env={...process.env,KMM_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
 async function launch(){app=await electron.launch({args:['.'],cwd:process.cwd(),env});page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',e=>errors.push(e.message));await page.locator('.sidebar').waitFor();await app.evaluate(({dialog})=>{globalThis.__compatFile='';dialog.showOpenDialog=async()=>({canceled:!globalThis.__compatFile,filePaths:globalThis.__compatFile?[globalThis.__compatFile]:[]});});}
 const panel=()=>page.getByRole('region',{name:'进程兼容测试',exact:true});
 const request=(name,...args)=>page.evaluate(async({name,args})=>{const r=await window.kmm[name](...args);if(!r.ok)throw new Error(r.error);return r.value;},{name,args});
 async function show(game){await page.getByLabel('当前游戏',{exact:true}).selectOption(game);await page.locator('.sidebar').getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'常规设置',exact:true}).click();await panel().scrollIntoViewIfNeeded();await panel().getByRole('button',{name:'检查记录适用性'}).waitFor();}
 async function importFile(file){await app.evaluate((_e,file)=>globalThis.__compatFile=file,file);await panel().getByRole('button',{name:'导入 SDK 测试记录'}).click();}
 async function shot(name){await panel().scrollIntoViewIfNeeded();const cdp=await page.context().newCDPSession(page);try{const r=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:false,captureBeyondViewport:false}),bytes=Buffer.from(r.data,'base64');assert.ok(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));await write(path.join(run,name+'.png'),bytes);}finally{await cdp.detach();}}
 await launch();
 for(const game of ['zzz','endfield']){
  await show(game);await panel().getByText(/尚未测试：/).waitFor();await importFile('');assert.equal((await request('compatibilityStatus',game)).state,'unverified');
  await importFile(fixtures[game].record);await panel().getByText(/进程层测试通过：/).waitFor();await panel().locator('summary').click();await panel().getByText(/未验证画面/).waitFor();await shot(game+'-passed');assert.equal((await request('compatibilityStatus',game)).state,'passed');
  await importFile(fixtures[game==='zzz'?'endfield':'zzz'].record);await panel().getByRole('alert').filter({hasText:'所属游戏'}).waitFor();assert.equal((await request('compatibilityStatus',game)).state,'passed');
  const update=path.join(settings.games[game].gameDirectory,'version.json');await write(update,{version:'new-build'});await panel().getByRole('button',{name:'检查记录适用性'}).click();await panel().getByText(/记录已过期：/).waitFor();await shot(game+'-stale');await fs.unlink(update);await panel().getByRole('button',{name:'检查记录适用性'}).click();await panel().getByText(/进程层测试通过：/).waitFor();
  const core=path.join(fixtures[game].xxmiRoot,fixtures[game].importer,'Core',fixtures[game].importer,'main.ini'),original=await fs.readFile(core);await fs.appendFile(core,';changed core');assert.equal((await request('compatibilityStatus',game)).state,'stale');await fs.writeFile(core,original);
  const {digest,...body}=fixtures[game].evidence,variant=path.join(fixtures[game].base,'variant.json');
  await write(variant,sealCompatibilityEvidence({...body,managerVersion:version+'-other'}));await importFile(variant);await panel().getByText(/记录已过期：/).waitFor();
  await write(variant,sealCompatibilityEvidence({...body,checks:{...body.checks,restart:'failed'},verdict:'failed'}));await importFile(variant);await panel().getByText(/进程层测试失败：/).waitFor();
  await write(variant,{...fixtures[game].evidence,digest:'0'.repeat(64)});await importFile(variant);await panel().getByRole('alert').filter({hasText:'摘要不符'}).waitFor();assert.equal((await request('compatibilityStatus',game)).state,'failed');
  await importFile(fixtures[game].record);await panel().getByText(/进程层测试通过：/).waitFor();
  checks.push(game+': actual Electron import/cancel/wrong-game and corrupt-digest rejection; scoped pass/failure shown; game/Core/manager-version changes invalidate record; invalid import preserves saved record');
 }
 // Preserve an inconclusive record and prove its state through an actual application restart.
 const f=fixtures.endfield,{digest,...body}=f.evidence;await write(f.record,sealCompatibilityEvidence({...body,checks:{...body.checks,recovery:'inconclusive'},verdict:'inconclusive'}));await importFile(f.record);await panel().getByText(/证据不足：/).waitFor();await app.close();app=null;await launch();await show('endfield');await panel().getByText(/证据不足：/).waitFor();await shot('restart-inconclusive');
 const promise=app.waitForEvent('window');await request('floating',true);const floating=await promise;assert.equal((await floating.evaluate(()=>window.kmm.compatibilityStatus('endfield'))).ok,false);await request('floating',false);checks.push('actual app restart retains per-game inconclusive record; floating-window compatibility API denied');
 assert.deepEqual(errors,[]);await write(path.join(run,'report.json'),{pass:true,run,checks,errors,scope:processMode?'owned compiled stand-in processes and actual isolated Electron windows; no real game/XXMI':'controlled imported evidence and actual isolated Electron windows; does not claim process suite or real game acceptance'});console.log(JSON.stringify({pass:true,run,checks}));
}catch(error){await write(path.join(run,'report.json'),{pass:false,run,checks,errors,error:error.stack});console.error(error);process.exitCode=1;}finally{if(app)await app.close().catch(()=>{});}
