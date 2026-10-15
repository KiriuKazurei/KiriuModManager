import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import electronExecutable from 'electron';
const root=process.cwd(),parent=path.resolve('.run-data/logging-smoke');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-')),data=path.join(run,'data');await fs.mkdir(data);
const settings={version:1,selectedGame:'zzz',games:{},desktop:{marketUrl:'',updateUrl:'',closeToTray:false}};
for(const game of ['zzz','endfield']){const modsDirectory=path.join(run,game,'Mods');await fs.mkdir(modsDirectory,{recursive:true});settings.games[game]={modsDirectory,xxmiRoot:'',gameDirectory:''};}
for(const name of ['Alpha','Beta']){const directory=path.join(settings.games.zzz.modsDirectory,name);await fs.mkdir(directory);await fs.writeFile(path.join(directory,'main.ini'),'[TextureOverrideFixture]\nhash=abcd1234\n');}
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify(settings));const env={...process.env,KMM_DATA_DIR:data};delete env.KMM_DEV_URL;delete env.KMM_DEBUG_PORT;delete env.ELECTRON_RUN_AS_NODE;
let app,page;const outcomes=[];
function value(result){assert.equal(result.ok,true,result.error);return result.value;}
async function launch(){app=await electron.launch({args:['.'],cwd:root,env,timeout:30000});page=await app.firstWindow();await page.locator('.sidebar-head').waitFor({timeout:20000});await page.bringToFront();}
async function poll(work,accept){const until=Date.now()+20000;while(Date.now()<until){const result=await work();if(accept(result))return result;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error('Timed out waiting for log evidence');}
try{
 await launch();const crashConfig=await app.evaluate(({app,crashReporter})=>({uploads:crashReporter.getUploadToServer(),directory:app.getPath('crashDumps')}));assert.equal(crashConfig.uploads,false);assert.ok(crashConfig.directory.startsWith(path.join(root,'log','crashes')));
 await app.evaluate(({shell})=>{shell.openPath=async directory=>{globalThis.__openedLogDirectory=directory;return '';};});
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('tab',{name:'诊断',exact:true}).click();await page.getByRole('button',{name:'打开日志目录',exact:true}).click();
 assert.equal(await poll(()=>app.evaluate(()=>globalThis.__openedLogDirectory),directory=>directory===path.join(root,'log')),path.join(root,'log'));outcomes.push('诊断日志入口调用固定实际日志目录；本地 Crashpad 关闭上传（系统目录打开由驱动代替）');
 const job=value(await page.evaluate(()=>window.kmm.startConflictInspection('zzz')));await poll(async()=>value(await page.evaluate(id=>window.kmm.readInspectionJob(id),job.id)),job=>job.stage==='complete');
 let report=value(await page.evaluate(()=>window.kmm.logReport('zzz')));assert.ok(report.findings.some(f=>f.kind==='mod-conflict-candidates'));outcomes.push('实际双 Mod hash 重叠经后台检查进入日志分析，保留任务和操作关联');
 const mods=value(await page.evaluate(()=>window.kmm.scanMods('zzz'))).mods;value(await page.evaluate(id=>window.kmm.operateMod('zzz',id,{kind:'tags',values:['LOG_SMOKE_SECRET']}),mods[0].id));
 const failed=await page.evaluate(()=>window.kmm.operateMod('zzz','00000000-0000-0000-0000-000000000000',{kind:'toggle',enabled:true}));assert.equal(failed.ok,false);
 await page.evaluate(()=>{setTimeout(()=>{throw new Error('Controlled renderer error token=LOG_SMOKE_SECRET');},0);void Promise.reject(new Error('Controlled renderer rejection cookie=LOG_SMOKE_SECRET'));});
 report=await poll(async()=>value(await page.evaluate(()=>window.kmm.logReport('zzz'))),report=>report.recent.some(row=>row.event==='renderer.error')&&report.recent.some(row=>row.event==='renderer.unhandled-rejection'));
 value(await page.evaluate(()=>window.kmm.floating(true)));const floating=await poll(async()=>app.windows().find(window=>window.url().includes('#floating')),Boolean);await floating.locator('.floating-view').waitFor();
 assert.equal((await floating.evaluate(()=>window.kmm.openLogDirectory())).ok,false);value(await floating.evaluate(()=>window.kmm.scanMods('zzz')));value(await page.evaluate(()=>window.kmm.floating(false)));outcomes.push('主窗、浮窗、读取、写操作、失败 IPC 和真实 renderer error / unhandledrejection 均有记录；浮窗禁止打开日志');
 await page.getByRole('button',{name:'分析日志',exact:true}).click();await page.locator('.logs-panel .log-location').waitFor();assert.equal(await page.locator('.logs-panel>.hint').last().isVisible(),true,'Log analysis limits must be visible');await page.screenshot({path:path.join(run,'diagnostics.png')});
 const profileId=createHash('sha256').update(data.toLowerCase()).digest('hex').slice(0,16),filename=path.join(report.directory,'application-'+profileId+'.jsonl');
 value(await page.evaluate(()=>window.kmm.logReport('zzz')));const contents=await fs.readFile(filename,'utf8');assert.ok(!contents.includes('LOG_SMOKE_SECRET'));assert.ok(contents.includes('"origin":"floating"'));assert.ok(contents.includes('renderer.navigation'));outcomes.push('日志文件排除表单值和带标签的凭据；诊断分析界面已截图');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
 await app.close();app=undefined;await launch();report=value(await page.evaluate(()=>window.kmm.logReport('zzz')));assert.ok(report.findings.some(f=>f.kind==='renderer-exit'));outcomes.push('实际终止独立测试界面的 renderer，重启后保留 Electron 进程退出证据');
 const owned=app.process(),identity=await app.evaluate(()=>({pid:process.pid,parent:process.ppid,executable:process.execPath,profile:process.env.KMM_DATA_DIR}));
 assert.equal(identity.profile,data);assert.equal(identity.executable.toLowerCase(),path.resolve(electronExecutable).toLowerCase());assert.ok(identity.pid===owned.pid||identity.parent===owned.pid,'Only terminate the launched process or its verified direct child');
 const exited=once(owned,'exit');process.kill(identity.pid,'SIGKILL');await exited;await app.close().catch(()=>{});app=undefined;
 await launch();report=value(await page.evaluate(()=>window.kmm.logReport('zzz')));assert.ok(report.findings.some(f=>f.kind==='abnormal-exit'));outcomes.push('实际强制结束本测试拥有的 Electron 主进程，重启识别上次未正常退出；未推断具体故障原因');
 assert.equal(value(await page.evaluate(()=>window.kmm.logReport('endfield'))).findings.some(f=>f.kind==='mod-conflict-candidates'),false);
 await fs.writeFile(path.join(run,'report.json'),JSON.stringify({pass:true,run,logDirectory:report.directory,crashConfig,outcomes},null,2));console.log(JSON.stringify({pass:true,run,outcomes}));
}catch(error){await page?.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(run,'report.json'),JSON.stringify({pass:false,run,outcomes,error:error.stack},null,2));console.error(error);process.exitCode=1;}
finally{await app?.close().catch(()=>{});}
