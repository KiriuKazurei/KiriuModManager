import {GameEnvironmentService} from './environment';
import {CompatibilityService} from './compatibility';
import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, net, shell, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SettingsStore, validateSettings, mergeDesktopPreferences } from './settings';
import { inspectXXMI } from './xxmi';
import { GameId, GAMES, ModOperation, Result, DEFAULT_APP_UPDATE_SOURCE } from '../shared/contracts';
import { DeploymentService } from './deployment';
import { checkRuntime, VC_DOWNLOAD_URL } from './runtime';
import { syncXXMIPaths } from './sync';
import { ModService } from './mods';
import { BusinessService } from './business';
import { IniService } from './ini';
import { launchPlan, spawnLauncher, gameExecutables, refreshKey, sendRefresh } from './desktop';
import { resolveWebUrl } from './web-links';
import type {IPCChannel,IPCArguments,IPCValue} from '../shared/ipc-contracts';
import {CharacterCoverService} from './character-covers';
import {AppUpdater,acknowledgeUpdate} from './app-updater';
import {ModBrowser} from './mod-browser';
import {OperationLog} from './operation-log';
import {DependencyError} from './dependencies';
import {ModUpdates} from './mod-updates';
import {Inspections} from './inspections';
import {PresetManifests} from './preset-manifests';
import {isInside} from './inspection-files';
import {ApplicationLog,useApplicationLog,logContext} from './application-log';
import {wireElectronLogging,startLocalCrashReports} from './electron-logging';
import {randomUUID} from 'node:crypto';
import {assertNoLinks} from './archive';
import {promises as fs} from 'node:fs';

const dataDirectory = process.env.KMM_DATA_DIR;
if (dataDirectory) {
  if (!path.isAbsolute(dataDirectory)) throw new Error('KMM_DATA_DIR must be an absolute path');
  app.setPath('userData', dataDirectory);
}
const debugPort = process.env.KMM_DEBUG_PORT;
if (debugPort && /^\d+$/.test(debugPort)) app.commandLine.appendSwitch('remote-debugging-port', debugPort);
let window: BrowserWindow | null = null;
let floatingWindow:BrowserWindow|null=null;let tray:Tray|null=null;let quitting=false;let closeToTray=true;
let trayMenu:Menu|null=null;
let modBrowser:ModBrowser|null=null;
let finishFileOperations:()=>Promise<void>=async()=>{};let quitDrained=false;
export function desktopRuntime(){return {window,floatingWindow,tray,trayMenu,modBrowser};}
const singleton=app.requestSingleInstanceLock();
let applicationLog:ApplicationLog|undefined;let logsClosed=false;
wireElectronLogging(()=>applicationLog);
if(!singleton)app.quit();
app.on('second-instance',()=>{if(window?.isMinimized())window.restore();window?.show();window?.focus();});
app.on('will-quit',event=>{if(applicationLog&&!logsClosed){event.preventDefault();logsClosed=true;void applicationLog.close().finally(()=>app.quit());}});
app.on('before-quit',event=>{quitting=true;if(!quitDrained){event.preventDefault();void Promise.allSettled([modBrowser?.close(),finishFileOperations()]).then(()=>{quitDrained=true;app.quit();});return;}tray?.destroy();tray=null;});
app.whenReady().then(async () => {
  if(!singleton)return;
  const installRoot=app.isPackaged?path.dirname(process.execPath):app.getAppPath();
  applicationLog=await ApplicationLog.open({installDirectory:installRoot,dataDirectory:app.getPath('userData'),version:app.getVersion(),runtime:{electron:process.versions.electron,node:process.versions.node}});useApplicationLog(applicationLog);
  await startLocalCrashReports(applicationLog);
  const store = new SettingsStore(app.getPath('userData'),installRoot);
  const operationLog=new OperationLog(app.getPath('userData'),applicationLog);
  const mods = new ModService(app.getPath('userData'), async game => (await store.read()).games[game]);
  const business=new BusinessService(app.getPath('userData'),mods,store);
  const inspections=new Inspections(app.getPath('userData'),store,mods,business,app.getVersion());
  const environment=new GameEnvironmentService(app.getPath('userData'),store,inspections.jobs);
  const compatibility=new CompatibilityService(app.getPath('userData'),app.getAppPath(),app.getVersion(),async game=>(await store.read()).games[game]);
  const presetManifests=new PresetManifests(app.getPath('userData'),mods,business,store);
  await mods.imports.initialize();
  const ini=new IniService(mods,business.recovery);
  const characterCovers=new CharacterCoverService(app.getPath('userData'),path.join(app.getAppPath(),'assets','character-covers'),mods,bytes=>!nativeImage.createFromBuffer(bytes).isEmpty());
  const deployment = new DeploymentService({ fetch: (url, options) => net.fetch(url, options), cacheDirectory: path.join(app.getPath('userData'), 'downloads'), checkRuntime: () => checkRuntime() });
  const updater=new AppUpdater({fetch:(url,options)=>net.fetch(url,options),currentVersion:app.getVersion(),cacheDirectory:path.join(app.getPath('userData'),'app-updates'),installRoot,packaged:app.isPackaged,helperPath:path.join(app.getAppPath(),'assets','update-helper.ps1'),protectedPaths:async()=>{const settings=await store.read();return [app.getPath('userData'),...Object.values(settings.games).flatMap(game=>[game.xxmiRoot,game.gameDirectory,...(game.modsDirectory&&isInside(path.join(installRoot,'Mods'),game.modsDirectory)?[]:[game.modsDirectory])])];}});
  let preparingUpdateInstall=false;
  const updateSource=async()=>(await store.read()).desktop?.updateSourceUrl??DEFAULT_APP_UPDATE_SOURCE;
  let pending:Promise<unknown>=Promise.resolve();
  const mutation=<T>(work:()=>Promise<T>):Promise<T>=>{const task=pending.then(work);pending=task.catch(()=>{});return task;};
  finishFileOperations=async()=>{environment.close();await mods.imports.close();await pending;await operationLog.flush();};
  const showMain=()=>{window?.show();if(window?.isMinimized())window.restore();window?.focus();};
  const broadcast=async(settingsChanged=false)=>{const settings=await store.read();for(const target of [window,floatingWindow])if(target&&!target.isDestroyed())target.webContents.send('desktop:changed',{gameId:settings.selectedGame,settingsChanged});};
  const trustedDocuments=new WeakMap<BrowserWindow,string>();
  const documentUrl=(value:string)=>{try{const url=new URL(value);url.hash='';return url.href;}catch{return '';}};
  const loadWindow=async(target:BrowserWindow,floating=false)=>{
    target.on('unresponsive',()=>{void applicationLog?.record('runtime','window.unresponsive',{origin:floating?'floating':'main'},'warning');});
    target.on('responsive',()=>{void applicationLog?.record('runtime','window.responsive',{origin:floating?'floating':'main'});});
    target.removeMenu();
    target.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    target.webContents.on('will-navigate',event=>event.preventDefault());
    target.webContents.on('will-redirect',event=>event.preventDefault());
    const devUrl=process.env.KMM_DEV_URL;
    const url=devUrl?new URL(devUrl):pathToFileURL(path.join(__dirname,'../renderer/index.html'));
    if(devUrl&&(url.hostname!=='127.0.0.1'||url.protocol!=='http:'))throw new Error('Development URL must be local');
    trustedDocuments.set(target,documentUrl(url.href));
    if(floating)url.hash='floating';
    await target.loadURL(url.href);
    target.setTitle(floating?'Kiriu 快速管理':'Kiriu Mod Manager');
  };
  const toggleFloating=async(visible:boolean)=>{if(typeof visible!=='boolean')throw new Error('浮窗设置无效。');if(!visible){floatingWindow?.close();return;}if(floatingWindow){floatingWindow.show();floatingWindow.focus();return;}floatingWindow=new BrowserWindow({title:'Kiriu 快速管理',width:380,height:540,minWidth:340,minHeight:360,alwaysOnTop:true,backgroundColor:'#0a0d14',show:false,icon:path.join(app.getAppPath(),'assets','app.ico'),webPreferences:{preload:path.join(__dirname,'../preload/index.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});floatingWindow.once('ready-to-show',()=>floatingWindow?.show());floatingWindow.on('closed',()=>{floatingWindow=null;void updateTray();});await loadWindow(floatingWindow,true);await updateTray();};
  const chooseGame=async(game:GameId)=>{if(typeof game!=='string'||!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');const settings=await store.read();const saved=await store.save({...settings,selectedGame:game});await broadcast(true);await updateTray();return saved;};
  const trayAction=(work:()=>Promise<unknown>)=>{void mutation(work).catch(error=>dialog.showErrorBox('桌面操作失败',(error as Error).message));};
  const updateTray=async()=>{if(!tray)return;const settings=await store.read();closeToTray=settings.desktop?.closeToTray??true;trayMenu=Menu.buildFromTemplate([{label:'显示主窗口',click:showMain},{type:'separator'},...(Object.keys(GAMES)as GameId[]).map(game=>({label:GAMES[game].name,type:'radio' as const,checked:settings.selectedGame===game,click:()=>trayAction(()=>chooseGame(game))})),{type:'separator'},{label:'快速管理浮窗',type:'checkbox',checked:!!floatingWindow,click:()=>trayAction(()=>toggleFloating(!floatingWindow))},{label:'退出 Kiriu Mod Manager',click:()=>app.quit()}]);tray.setContextMenu(trayMenu);};
  // Progress and window controls remain available while a file operation or native dialog waits.
  const responsiveChannels=new Set(['desktop:window-theme','desktop:status','desktop:floating','desktop:show','desktop:quit','deployment:progress','runtime:check','runtime:download','directory:choose','update:status','update:check','update:download','market:view','market:status','market:navigate','market:download-action','market:install-plan','mod-import:files','mod-import:discard','inspection:read','inspection:cancel','conflicts:details','recovery:cleanup-job']);
  const handle = <C extends IPCChannel>(channel:C, work:(...args:IPCArguments<C>)=>Promise<IPCValue<C>>) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Result<IPCValue<C>>> => {
      const sender=[window,floatingWindow].find(target=>target&&!target.isDestroyed()&&event.sender===target.webContents);
      const deny=(error:string):Result<IPCValue<C>>=>{void applicationLog?.record('ipc','ipc.denied',{action:channel,origin:sender===floatingWindow?'floating':sender===window?'main':'untrusted',reason:error},'warning');return {ok:false,error};};
      if (!sender || event.senderFrame !== sender.webContents.mainFrame || documentUrl(event.senderFrame.url)!==trustedDocuments.get(sender)) {void applicationLog?.record('ipc','ipc.denied',{action:channel,reason:'untrusted-frame'},'warning');return { ok: false, error: '此页面无权访问桌面接口。' };}
      if(channel.startsWith('logs:')&&channel!=='logs:renderer'&&sender!==window){void applicationLog?.record('ipc','ipc.denied',{action:channel,reason:'main-window-only'},'warning');return {ok:false,error:'请在主窗口查看诊断日志。'};}
      if(channel.startsWith('environment:')&&sender!==window)return deny('请在主窗口检查和修复游戏环境。');
      if(channel.startsWith('compatibility:')&&sender!==window)return deny('请在主窗口查看兼容测试记录。');
      if((channel.startsWith('mod-import:')||channel==='mods:import')&&sender!==window)return deny('请在主窗口使用导入预检。');
      if(channel==='desktop:window-theme'&&sender!==window)return deny('请在主窗口设置标题栏主题。');
      if((channel.startsWith('preset-manifest:')||['presets:preview','presets:commit','presets:apply'].includes(channel))&&sender!==window)return deny('请在主窗口使用预设预览与清单。');
      if((channel.startsWith('inspection:')||channel.startsWith('diagnostics:')||['recovery:restore','recovery:create','recovery:protect','recovery:prepare-restore','recovery:apply-restore','recovery:prepare-cleanup','recovery:apply-cleanup','recovery:cleanup-job','conflicts:details'].includes(channel))&&sender!==window)return deny('请在主窗口使用诊断、恢复管理和冲突详情。');
      if((channel.startsWith('market:')||channel==='desktop:link'&&args[1]==='market')&&sender!==window)return deny('请在主窗口使用获取 Mod 和下载进度。');
      const run=async():Promise<Result<IPCValue<C>>>=>{
      if(updater.status.stage==='installing'&&!['update:status','desktop:status','desktop:show','desktop:quit'].includes(channel))return {ok:false,error:'正在退出并安装更新，请等待重新打开。'};
      try { const value=await operationLog.run(channel,args,()=>work(...args as IPCArguments<C>),sender===floatingWindow?'floating':'main');if(/^(settings:(save|save-game-paths|save-desktop-preferences)|mods:(operate|batch|exclusive-save|exclusive-delete|import|replace|delete|choose-cover|group)|presets:(save|add-members|delete|apply|commit)|mod-import:commit|preset-manifest:(commit|replacement)|profiles:(capture|duplicate|apply)|ini:save|recovery:(create|restore|apply-restore|apply-cleanup|protect)|xxmi:(deploy|sync))$/.test(channel)&&!(['presets:commit','mod-import:commit'].includes(channel)&&value===null)){if(args[0]==='zzz'||args[0]==='endfield')inspections.jobs.invalidate(args[0]);await broadcast(/^(settings:(save|save-game-paths|save-desktop-preferences)|recovery:(restore|apply-restore)|xxmi:(deploy|sync))$/.test(channel));await updateTray();}return { ok: true, value }; }
      catch (error) {
        if(['mods:operate','mods:exclusive-save','recovery:restore','recovery:apply-restore'].includes(channel))await broadcast().catch(()=>{});
        if(error instanceof DependencyError)return {ok:false,error:error.message,code:error.code,details:error.details};
        const code = (error as NodeJS.ErrnoException).code;
        const errorText = code ? `目录操作失败（${code}），请检查路径和权限。` : (error as Error).message;
        return { ok: false, error: errorText || '操作失败，请检查路径和权限。' };
      }
      };
      if(channel==='logs:renderer')return logContext.run({operationId:randomUUID(),action:channel,origin:sender===floatingWindow?'floating':'main'},async()=>{const result=await run();if(!result.ok)await applicationLog?.record('logging','renderer.payload-rejected',{},'warning');return result;});
      const requestId=randomUUID(),received=Date.now(),origin=sender===floatingWindow?'floating':'main';
      void applicationLog?.record('ipc','ipc.received',{operationId:requestId,action:channel,origin});
      const execute=()=>logContext.run({operationId:requestId,action:channel,...(args[0]==='zzz'||args[0]==='endfield'?{gameId:args[0]}:{})},async()=>{
        await applicationLog?.record('ipc','ipc.dispatched',{origin,queueMs:Date.now()-received});
        const result=await run();await applicationLog?.record('ipc','ipc.response',{origin,ok:result.ok,durationMs:Date.now()-received},result.ok?'info':'error',result.ok?undefined:new Error(result.error));return result;
      });
      return responsiveChannels.has(channel)||channel.startsWith('logs:')?execute():mutation(execute);
    });
  };
  handle('logs:report',async game=>{if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');return applicationLog!.report(game);});
  handle('logs:open',async()=>{const directory=applicationLog!.directory;await assertNoLinks(directory);await fs.mkdir(directory,{recursive:true});const error=await shell.openPath(directory);if(error)throw new Error('无法打开日志目录：'+error);});
  const rendererRates=new Map<number,{second:number;count:number}>();
  handle('logs:renderer',async event=>{
    if(!event||typeof event!=='object'||!['action','navigation','error','unhandled-rejection','react-error'].includes(event.kind)||Object.keys(event).some(key=>!['kind','control','page','gameId','message','stack'].includes(key))||event.gameId!==undefined&&!Object.hasOwn(GAMES,event.gameId)||['control','page','message','stack'].some(key=>{const value=event[key as keyof typeof event];return value!==undefined&&(typeof value!=='string'||value.length>6000);}))throw new Error('界面日志格式无效。');
    // No form values, arbitrary paths, URL payloads or account data are accepted.
    const second=Math.floor(Date.now()/1000),rate=rendererRates.get(process.pid);if(rate?.second===second){if(++rate.count>200){if(rate.count===201)await applicationLog!.record('logging','renderer.rate-limited',{},'warning');return;}}else rendererRates.set(process.pid,{second,count:1});
    const error=['error','unhandled-rejection','react-error'].includes(event.kind)?Object.assign(new Error(event.message||'Renderer error'),{stack:event.stack}):undefined;
    await applicationLog!.record('renderer','renderer.'+event.kind,{control:event.control,page:event.page,gameId:event.gameId},error?'error':'info',error);
  });
  handle('environment:check',(game,mode)=>environment.start(game,mode));
  handle('compatibility:status',game=>compatibility.read(game));
  handle('compatibility:import',async game=>{if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏');const choice=await dialog.showOpenDialog(window!,{title:'导入 SDK 进程兼容记录',properties:['openFile'],filters:[{name:'SDK 兼容记录',extensions:['json']}]});return choice.canceled||!choice.filePaths[0]?null:compatibility.import(game,choice.filePaths[0]);});
  handle('environment:choose',async(game,kind)=>{if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');if(!['game','loader'].includes(kind))throw new Error('安装位置类型无效。');const choice=await dialog.showOpenDialog(window!,{title:kind==='game'?'选择游戏安装目录':'选择 XXMI 外层安装根',properties:['openDirectory']});return choice.canceled||!choice.filePaths[0]?null:environment.start(game,'discover',{kind,directory:choice.filePaths[0]});});
  handle('environment:prepare',(game,request)=>environment.prepare(game,request));
  handle('environment:apply',async(game,token)=>{const plan=environment.readPlan(game,token);const answer=await dialog.showMessageBox(window!,{type:'warning',title:plan.action==='rollback'?'确认回退环境修复':'确认游戏路径修复',message:plan.action==='rollback'?'回退此记录中的环境改动？':'提交已预览的路径修复？',detail:[GAMES[game].name,...plan.changes.map(c=>c.role+'：'+c.before+' → '+c.after),...plan.warnings].join('\n').slice(0,16000),buttons:['取消','确认提交'],defaultId:0,cancelId:0});if(answer.response!==1)return null;try{return await environment.apply(game,token);}finally{inspections.jobs.invalidate(game);await broadcast(true);}});
  const confirmImport=async(game:GameId,token:string,acceptIncomplete:boolean)=>{
    const preview=mods.imports.readPlan(game,token);if(!preview.canCommit)throw new Error('所选条目存在阻挡，请修改后更新预检。');
    const selected=preview.items.filter(i=>i.selected);const choice=await dialog.showMessageBox(window!,{type:'question',title:'确认导入 Mod',message:`导入 ${selected.length} 项 Mod（默认停用）？`,detail:[GAMES[game].name+' · '+preview.root,...selected.map(i=>[i.folder,'DISABLED_'+i.name].filter(Boolean).join('/')+' · '+i.bytes+' 字节'),`跳过 ${preview.items.length-selected.length} 项；不覆盖已有内容。`,...preview.space.map(v=>v.location+' 需要 '+v.required+' 字节，可用 '+(v.available??'未知'))].join('\n').slice(0,16000),buttons:['取消','确认导入'],defaultId:0,cancelId:0});
    if(choice.response!==1)return null;
    if(preview.downloadTaskId)await browser().beginImport(preview.downloadTaskId);
    try{const result=await mods.imports.commit(game,token,acceptIncomplete);if(preview.downloadTaskId)await browser().recordImport(preview.downloadTaskId,result);return result;}catch(error){if(preview.downloadTaskId)await browser().failImport(preview.downloadTaskId,(error as Error).message).catch(()=>{});throw error;}
  };
  const legacyImport=async(game:GameId,files:string[])=>{
    const preview=await mods.imports.prepareLocal(game,files);
    try{return await confirmImport(game,preview.token,false)||{library:await mods.scan(game),importedIds:[],errors:[],canceled:true};}finally{await mods.imports.discard(game,preview.sessionId);}
  };
  handle('mod-import:prepare',async(game,source)=>{
    if(!source||!['folder','archive','download'].includes(source.kind))throw new Error('导入来源类型无效。');
    if(source.kind==='download'){const input=browser().importSource(source.taskId);if(input.gameId!==game)throw new Error('下载任务与所选游戏不匹配。');return inspections.jobs.start('mod-import',game,(await store.read()).games[game],async(signal,progress)=>{try{return await mods.imports.prepareDownload(game,input,signal,progress);}catch(error){if(!signal.aborted)await browser().failImport(source.taskId,(error as Error).message).catch(()=>{});throw error;}},undefined,JSON.stringify(source));}
    const choice=await selectSource(source.kind,true);if(choice.canceled||!choice.filePaths.length)return null;
    return inspections.jobs.start('mod-import',game,(await store.read()).games[game],(signal,progress)=>mods.imports.prepareLocal(game,choice.filePaths,signal,progress),undefined,JSON.stringify(choice.filePaths));
  });
  handle('mod-import:revise',async(game,id,choices)=>inspections.jobs.start('mod-import',game,(await store.read()).games[game],(signal,progress)=>mods.imports.revise(game,id,choices,signal,progress),undefined,JSON.stringify([id,choices])));
  handle('mod-import:files',(game,id,entry,offset)=>mods.imports.files(game,id,entry,offset));
  handle('mod-import:commit',(game,token,accept)=>confirmImport(game,token,accept));
  handle('mod-import:discard',(game,id)=>mods.imports.discard(game,id));
  handle('settings:read', () => store.read());
  handle('presets:preview',async(game,id,choices,excluded)=>inspections.jobs.start('preset-preview',game,(await store.read()).games[game],async(signal,progress)=>{progress('核对预设最终启停与联动');return business.presetPlanner.prepare(game,id,choices,excluded,signal);},undefined,JSON.stringify([id,choices,excluded])));
  const confirmPreset=async(game:GameId,token:string,confirmation?:import('../shared/contracts').DependencyConfirmation)=>{
    const stored=await business.presetPlanner.validate(game,token);if(!stored.plan.canApply)throw new Error('请处理预览中的阻挡后重新预览。');
    const choice=await dialog.showMessageBox(window!,{type:'question',title:'确认应用预设',message:'应用“'+stored.plan.name+'”？',detail:[`游戏：${GAMES[game].name}；根：${stored.plan.root}`,`实际目录变化 ${stored.plan.changes} 项；不写 INI。`,...stored.plan.rows.filter(row=>['enable','disable'].includes(row.status)).slice(0,80).map(row=>`${row.desired?'启用':'停用'} ${row.name}${row.outside?'（预设外联动）':''}`)].join('\n'),buttons:['取消','应用预设'],defaultId:0,cancelId:0});
    return choice.response===1?business.presetPlanner.commit(game,token,confirmation):null;
  };
  handle('presets:commit',(game,token,confirmation)=>confirmPreset(game,token,confirmation));
  handle('preset-manifest:prepare-export',async(game,id,includeProfile)=>inspections.jobs.start('preset-export',game,(await store.read()).games[game],(signal,progress)=>presetManifests.prepareExport(game,id,includeProfile,signal,progress),undefined,JSON.stringify([id,includeProfile])));
  handle('preset-manifest:export',async(game,token)=>{const plan=presetManifests.readExport(game,token),extension=plan.manifest.profile?'zip':'json';const choice=await dialog.showSaveDialog(window!,{title:'导出预设清单',defaultPath:plan.preview.name+(plan.manifest.profile?'.kmm-profile.zip':'.kmm-preset.json'),filters:[{name:'Kiriu 预设清单',extensions:[extension]}],properties:['showOverwriteConfirmation']});return choice.canceled||!choice.filePath?null:presetManifests.export(game,token,choice.filePath);});
  handle('preset-manifest:prepare-import',async(game,draftId)=>{
    let file:string|undefined;if(!draftId){const choice=await dialog.showOpenDialog(window!,{title:'导入预设清单',properties:['openFile'],filters:[{name:'Kiriu 预设清单／配置',extensions:['json','zip']}]});if(choice.canceled||!choice.filePaths[0])return null;file=choice.filePaths[0];}
    return inspections.jobs.start('preset-import',game,(await store.read()).games[game],(signal,progress)=>presetManifests.prepareImport(game,file,draftId,signal,progress),undefined,JSON.stringify([file,draftId]));
  });
  handle('preset-manifest:revise',async(game,id,choices)=>inspections.jobs.start('preset-import',game,(await store.read()).games[game],(signal,progress)=>presetManifests.revise(game,id,choices,signal,progress),undefined,JSON.stringify([id,choices])));
  handle('preset-manifest:commit',(game,token,options)=>presetManifests.commit(game,token,options));
  handle('preset-manifest:replacement',async(game,id,kind)=>{
    await presetManifests.session(game,id);if(!['folder','archive'].includes(kind))throw new Error('替代来源类型无效。');const choice=await dialog.showOpenDialog(window!,{title:'导入本地替代 Mod（默认停用）',properties:[kind==='folder'?'openDirectory':'openFile'],...(kind==='archive'?{filters:[{name:'Mod 压缩包',extensions:['zip','7z','rar']}]}:{})});
    if(choice.canceled||!choice.filePaths.length)return {library:await mods.scan(game),importedIds:[],errors:[],canceled:true};await presetManifests.session(game,id);
    const settings=await store.read(),protectedRoots=[app.getPath('userData'),...Object.values(settings.games).map(paths=>paths.modsDirectory).filter(Boolean)];if(choice.filePaths.some(source=>protectedRoots.some(root=>isInside(root,source)||isInside(source,root))))throw new Error('替代来源不能与数据目录或任一游戏 Mod 库重叠。');return legacyImport(game,choice.filePaths);
  });
  handle('inspection:diagnostics',game=>inspections.start('diagnostics',game));
  handle('inspection:inventory',game=>inspections.start('inventory',game));
  handle('inspection:conflicts',game=>inspections.start('conflicts',game));
  handle('inspection:read',id=>inspections.jobs.read(id));
  handle('inspection:cancel',async id=>inspections.jobs.cancel(id));
  handle('diagnostics:preview',async(id,options)=>inspections.diagnostics.preview(await inspections.jobs.read(id,true),options));
  handle('diagnostics:export',async(id,format,options)=>{
    const job=await inspections.jobs.read(id,true);inspections.diagnostics.preview(job,options);
    const choice=await dialog.showSaveDialog(window!,{title:'导出脱敏本地诊断报告',defaultPath:`Kiriu-${job.gameId}-diagnostics.${format==='json'?'json':'md'}`,filters:[{name:format==='json'?'JSON':'Markdown',extensions:[format==='json'?'json':'md']}],properties:['showOverwriteConfirmation']});
    if(choice.canceled||!choice.filePath)return null;const current=await store.read();const forbidden=Object.values(current.games).flatMap(p=>Object.values(p)).filter(Boolean);if(forbidden.some(root=>{const relative=path.relative(path.resolve(root),path.resolve(choice.filePath!));return !relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}))throw new Error('报告不能写入任一游戏、Mod 或加载器目录。');
    return inspections.diagnostics.save(await inspections.jobs.read(id,true),format,options,choice.filePath);
  });
  handle('recovery:protect',(game,ids,value)=>inspections.storage.setProtection(game,ids,value));
  handle('recovery:prepare-restore',(game,id)=>inspections.start('restore-preview',game,id));
  const confirmRestore=async(game:GameId,token:string,confirmation?:import('../shared/contracts').DependencyConfirmation)=>{const plan=business.restorePlanner.readPlan(game,token);if(plan.kind==='snapshot')await environment.assertReady(game,true);if(!plan.complete)throw new Error('恢复范围不完整或存在阻断，请先处理。');const choice=await dialog.showMessageBox(window!,{type:'warning',title:'确认恢复预览',message:`恢复“${plan.name}”？`,detail:[`游戏：${GAMES[game].name}；根：${plan.root}`,...plan.scope.map(s=>`${s.role}：${s.path}\n${s.action}`),...plan.warnings].join('\n').slice(0,16000),buttons:['取消','恢复所选备份'],defaultId:0,cancelId:0});return choice.response===1?business.restore(game,plan.id,confirmation,token):null;};
  handle('recovery:apply-restore',(game,token,confirmation)=>confirmRestore(game,token,confirmation));
  handle('recovery:prepare-cleanup',(game,ids)=>inspections.storage.prepare(game,ids));
  handle('recovery:apply-cleanup',async(game,token)=>{const plan=inspections.storage.readPlan(game,token);const choice=await dialog.showMessageBox(window!,{type:'warning',title:'永久清理所选副本',message:`永久清理 ${plan.items.length} 个副本？`,detail:plan.items.map(i=>`${i.name} · ${i.kind} · ${i.root} · ${i.bytes} 逻辑字节`).concat(plan.warnings).join('\n').slice(0,16000),buttons:['取消','永久清理所选副本'],defaultId:0,cancelId:0});if(choice.response!==1)return null;const job=await inspections.storage.begin(game,token);void mutation(async()=>{await operationLog.run('recovery:cleanup-run',[game,job.id],()=>inspections.storage.manage(game,job.id,'continue'));await broadcast();}).catch(()=>{});return job;});
  handle('recovery:cleanup-job',async(game,id,action)=>{if(action==='read'||action==='cancel')return inspections.storage.manage(game,id,action);if(!['continue','undo'].includes(action))throw new Error('清理操作无效。');return mutation(async()=>{const job=await inspections.storage.manage(game,id,'read');const choice=await dialog.showMessageBox(window!,{type:'warning',title:action==='continue'?'继续永久清理':'撤回完整副本',message:action==='continue'?'继续删除清理记录中的剩余内容？':'将尚未开始永久删除的完整副本撤回恢复区？',detail:job.items.map(i=>`${i.name} · ${i.phase} · ${i.message}`).join('\n').slice(0,16000),buttons:['取消',action==='continue'?'继续永久清理':'撤回完整副本'],defaultId:0,cancelId:0});if(choice.response!==1)return null;if(action==='undo')return inspections.storage.manage(game,id,action);void mutation(async()=>{await operationLog.run('recovery:cleanup-run',[game,id],()=>inspections.storage.manage(game,id,'continue'));await broadcast();}).catch(()=>{});return {...job,phase:'working' as const};});});
  handle('conflicts:details',(game,resultId,groupId,offset)=>inspections.conflicts.details(game,resultId,groupId,offset));
  handle('inspection:reveal',async(game,reference)=>{shell.showItemInFolder(await inspections.location(game,reference));});
  const modUpdates=new ModUpdates(mods,(url,options)=>browser().fetch(url,options));
  const browser=()=>{if(!modBrowser)throw new Error('内置浏览器尚未就绪。');return modBrowser;};
  handle('desktop:window-theme',async theme=>{
    if(theme!=='day'&&theme!=='night')throw new Error('窗口主题无效。');
    const color=theme==='day'?'#e4e8f0':'#1a1e27';const symbolColor=theme==='day'?'#16181e':'#f4f1ea';
    if(window&&!window.isDestroyed()){window.setBackgroundColor(color);if(process.platform!=='darwin')window.setTitleBarOverlay({color,symbolColor,height:32});}
  });
  handle('market:view',async(game,bounds)=>browser().setView(game,bounds));
  handle('market:status',async()=>browser().status());
  handle('market:navigate',async action=>browser().navigate(action));
  handle('market:download-action',async(id,action,destinations)=>{if(action==='retry-install'&&!browser().status().downloads.find(t=>t.id===id)?.updateTarget)throw new Error('新 Mod 请使用下载页的统一预检安装。');return browser().downloadAction(id,action,destinations);});
  handle('market:install-plan',async id=>browser().installPlan(id));
  handle('update:check',async()=>updater.check(await updateSource()));
  handle('update:status',()=>updater.readStatus());
  handle('update:download',async()=>{
    const source=await updateSource();return updater.download(source,async release=>{const choice=await dialog.showMessageBox(window!,{type:'question',title:'下载管理器更新',message:`下载 ${release.version}？`,detail:`更新来源：${source}\n大小：${(release.size/1024**2).toFixed(1)} MiB\n\n${release.notes}`,buttons:['取消','下载更新'],defaultId:0,cancelId:0});if(choice.response===1&&source!==await updateSource())throw new Error('更新源已改变，请重新检查。');return choice.response===1;});
  });
  handle('update:install',async()=>{
    for(const game of Object.keys(GAMES)as GameId[])await environment.assertReady(game,true);
    if(environment.hasActive())throw new Error('请先等待环境修复完成，再安装管理器更新。');
    if(mods.imports.hasActive())throw new Error('请先等待导入准备／提交完成或取消，再安装管理器更新。');
    if(inspections.storage.hasActive())throw new Error('请先等待恢复区清理完成或取消，再安装管理器更新。');
    if(modBrowser?.hasActiveDownloads())throw new Error('请先等待 Mod 下载和安装完成，或取消下载，再安装管理器更新。');
    preparingUpdateInstall=true;
    try {
    const source=await updateSource();const result=await updater.install(source,async release=>{const choice=await dialog.showMessageBox(window!,{type:'warning',title:'安装管理器更新',message:`退出并安装 ${release.version}？`,detail:'请先保存所有未提交的编辑。程序将退出、替换完整便携目录并重新打开。用户数据和 Mod 文件保持；旧版仅临时用于失败回退，新版启动确认成功后删除。',buttons:['取消','退出并安装'],defaultId:0,cancelId:0});if(choice.response===1&&source!==await updateSource())throw new Error('更新源已改变，请重新检查。');return choice.response===1;});if(result)setTimeout(()=>app.quit(),250);return result;
    }finally{preparingUpdateInstall=false;}
  });
  handle('desktop:status',async()=>({trayAvailable:!!tray&&!tray.isDestroyed(),floatingVisible:!!floatingWindow&&floatingWindow.isVisible(),version:app.getVersion()}));
  handle('desktop:floating',(visible:boolean)=>toggleFloating(visible));
  handle('desktop:show',async()=>showMain());
  handle('desktop:quit',async()=>{setImmediate(()=>app.quit());});
  handle('desktop:game',(game:GameId)=>chooseGame(game));
  handle('desktop:launch',async (game:GameId,mode:'gui'|'game')=>{const settings=await store.read();if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');if(mode==='game')await environment.assertReady(game,true);const plan=await launchPlan(game,settings.games[game],mode);await spawnLauncher(plan);return mode==='gui'?'XXMI 打开请求已提交，请检查 Launcher 窗口。':'XXMI 启动请求已提交；不代表游戏或 Mod 已加载，请检查游戏窗口。';});
  handle('desktop:refresh',async (game:GameId)=>{const settings=await store.read();if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');await environment.assertReady(game,true);const installation=await inspectXXMI(game,settings.games[game].xxmiRoot);if(!installation.installed)throw new Error('所选 loader 未安装，无法确认刷新键。');if(!installation.gameDirectory||path.resolve(installation.gameDirectory).toLowerCase()!==path.resolve(settings.games[game].gameDirectory).toLowerCase())throw new Error('Launcher 游戏目录与设置不一致，请先到路径设置的“检查与修复”修复。');const executables=await gameExecutables(game,settings.games[game].gameDirectory);const key=await refreshKey(installation.iniPath);const sent=await sendRefresh(path.join(app.getAppPath(),'assets','refresh-helper.ps1'),executables,key.virtualKey);return `${key.name} 刷新请求已发送到所选游戏窗口（PID ${sent.pid}）。${key.defaultKey?'未找到自定义配置，使用默认 F10。':''}请在游戏中确认效果。`;});
  handle('desktop:link',async (game:GameId,kind:'market'|'update')=>{if(!Object.hasOwn(GAMES,game)||!['market','update'].includes(kind))throw new Error('网页入口无效。');if(kind==='market'){await browser().navigate('home',game);return `${GAMES[game].name}网页已载入，请在左侧获取Mod中浏览。`;}const settings=await store.read();const url=resolveWebUrl(settings.desktop?.updateUrl||'',game,kind);if(!url)throw new Error('尚未配置更新发布页。');await shell.openExternal(url);return '网页打开请求已提交到默认浏览器。';});
  handle('presets:list',(game:GameId)=>business.presets(game));
  handle('presets:save',(game:GameId,id:string|null,name:string,members:Record<string,boolean>|null)=>business.savePreset(game,id,name,members));
  handle('presets:add-members',(game,id,modIds)=>business.addModsToPreset(game,id,modIds));
  handle('presets:delete',(game:GameId,id:string)=>business.deletePreset(game,id));
  handle('presets:apply',async(game,id,choices,confirmation)=>{const plan=await business.presetPlanner.prepare(game,id,choices);if(plan.dependency.issues.some(issue=>issue.severity==='block'))throw new DependencyError(plan.dependency);if(!plan.canApply)return {library:await mods.scan(game),applied:0,conflicts:plan.conflicts,issues:plan.blockers};const result=await confirmPreset(game,plan.token,confirmation);return {library:result?.library||await mods.scan(game),applied:result?(result.applied+result.unchanged):0,conflicts:[],issues:result?[]:['已取消应用预设。']};});
  handle('profiles:scope',(game,id)=>business.profiles.scope(game,id));
  handle('profiles:capture',(game,id,name,scope)=>business.profiles.capture(game,id,name,scope));
  handle('profiles:duplicate',(game,id,name)=>business.profiles.duplicate(game,id,name));
  handle('profiles:status',(game,id)=>business.profiles.status(game,id));
  handle('profiles:prepare',(game,id,choices,strategy)=>business.profiles.prepare(game,id,choices,strategy));
  handle('profiles:apply',(game,token,strategy,confirmation)=>business.profiles.apply(game,token,strategy,confirmation));
  handle('profiles:read',(game,id,file)=>business.profiles.read(game,id,file));
  handle('mods:dependencies',(game,request)=>mods.dependencyCheck(game,request));
  handle('mods:updates',(game,ids)=>modUpdates.check(game,ids));
  handle('mods:prepare-update',async(game,id,candidate)=>{const prepared=await modUpdates.prepare(game,id,candidate);const record=(await mods.context(game,id)).record!;const choice=await dialog.showMessageBox(window!,{type:'question',title:'下载 Mod 更新候选',message:'下载候选文件 '+prepared.binding.remote.fileName+'？',detail:'目标：'+record.relativePath+'\n声明版本：'+(prepared.binding.version||'未知')+'\n下载后仍需在下载页面确认替换，文件不会自动升级。',buttons:['取消','下载候选'],defaultId:0,cancelId:0});return choice.response===1?browser().queueUpdate(prepared.binding,prepared.target):null;});
  handle('ini:list',(game:GameId,id:string)=>ini.files(game,id));
  handle('ini:read',(game:GameId,id:string,file:string)=>ini.read(game,id,file));
  handle('ini:save',(game:GameId,id:string,file:string,digest:string,edit)=>ini.save(game,id,file,digest,edit));
  handle('conflicts:scan',(game:GameId)=>ini.conflicts(game));
  handle('recovery:list',(game:GameId)=>business.recovery.list(game));
  handle('recovery:create',(game:GameId,name:string)=>business.createBackup(game,name));
  handle('recovery:restore',async(game,id,confirmation)=>{const plan=await business.restorePlanner.prepare(game,id);return confirmRestore(game,plan.token,confirmation);});
  handle('settings:save', async input => {for(const game of Object.keys(GAMES)as GameId[])await environment.assertReady(game);return store.save(input);});
  handle('settings:save-game-paths',async(game,patch)=>{await environment.assertReady(game);return store.saveGamePaths(game,patch);});
  handle('settings:save-desktop-preferences',async patch=>store.save(mergeDesktopPreferences(await store.read(),patch)));
  handle('xxmi:inspect', (game: GameId, root: string) => inspectXXMI(game, root));
  handle('mods:scan', (game: GameId) => mods.scan(game));
  handle('mods:operate', (game,id,operation,confirmation) => mods.operate(game,id,operation,undefined,confirmation));
  handle('mods:batch',(game,ids,operation,choices,confirmation)=>mods.batch(game,ids,operation,choices,confirmation));
  handle('mods:exclusive-save',(game,id,name,modIds,enabledId,confirmation)=>mods.saveExclusiveGroup(game,id,name,modIds,enabledId,confirmation));
  handle('mods:exclusive-delete',(game,id)=>mods.deleteExclusiveGroup(game,id));
  handle('mods:source',async(game,id)=>{const url=await mods.sourceUrl(game,id);await shell.openExternal(url);return '来源网页打开请求已提交。';});
  handle('mods:cover', (game: GameId,id: string) => mods.cover(game,id));
  handle('characters:covers',(game:GameId)=>characterCovers.read(game));
  handle('characters:choose-cover',async (game:GameId,name:string)=>{const source=await dialog.showOpenDialog(window!,{title:'选择角色文件夹封面',properties:['openFile'],filters:[{name:'PNG / JPEG 图片',extensions:['png','jpg','jpeg']}]});if(source.canceled)return null;const result=await characterCovers.choose(game,name,source.filePaths[0]);await broadcast();return result;});
  handle('mods:group', (game: GameId,kind: 'category'|'character'|'appearance',name: string) => mods.addGroup(game,kind,name));
  const selectSource = async (kind: 'folder'|'archive', multiple: boolean) => {
    if (!['folder','archive'].includes(kind)) throw new Error('导入类型无效。');
    return dialog.showOpenDialog(window!, { title:kind==='folder'?'选择本地 Mod 文件夹':'选择 Mod 压缩包', properties:kind==='folder'?(multiple?['openDirectory','multiSelections']:['openDirectory']):(multiple?['openFile','multiSelections']:['openFile']), filters:kind==='archive'?[{name:'Mod 压缩包',extensions:['zip','7z','rar']}]:undefined });
  };
  handle('mods:import', async (game: GameId,kind: 'folder'|'archive') => {
    const source=await selectSource(kind,true); if(source.canceled) return {library:await mods.scan(game),importedIds:[],errors:[],canceled:true}; return legacyImport(game,source.filePaths);
  });
  handle('mods:replace', async (game,id,kind,confirmation) => {
    const source=await selectSource(kind,false); return source.canceled?null:mods.replace(game,id,source.filePaths[0],confirmation);
  });
  handle('mods:delete', async (game,id,confirmation) => {
    const snapshot=await mods.scan(game); const target=snapshot.mods.find(mod=>mod.id===id); if(!target) throw new Error('Mod 不存在，请重新扫描。');
    const choice=await dialog.showMessageBox(window!,{type:'warning',title:'移到恢复区',message:`移除“${target.name}”？`,detail:'文件会从 loader 读取目录移除，恢复副本保存在管理器数据目录的 removed 文件夹。不会静默永久删除。',buttons:['取消','移到恢复区'],defaultId:0,cancelId:0});
    return choice.response===1?mods.delete(game,id,confirmation):null;
  });
  handle('mods:choose-cover', async (game:GameId,id:string) => {
    const source=await dialog.showOpenDialog(window!,{title:'选择 Mod 预览图',properties:['openFile'],filters:[{name:'本地图片',extensions:['png','jpg','jpeg','webp','gif']}]});
    return source.canceled?null:mods.setCover(game,id,source.filePaths[0]);
  });
  handle('deployment:progress', async () => deployment.progress);
  handle('runtime:check', checkRuntime);
  handle('runtime:download', async () => { await shell.openExternal(VC_DOWNLOAD_URL); });
  const gameConfiguration=async(input:unknown)=>{const requested=validateSettings(input);const current=await store.read();return {...current,selectedGame:requested.selectedGame,games:{...current.games,[requested.selectedGame]:requested.games[requested.selectedGame]}};};
  handle('xxmi:deploy', async input => {
    await environment.assertReady(validateSettings(input).selectedGame,true);
    const settings = await gameConfiguration(input); const gameId = settings.selectedGame;
    const fields = settings.games[gameId];
    if (!fields.modsDirectory) fields.modsDirectory = path.join(installRoot,'Mods',gameId==='zzz'?'ZZZ':'Endfield');
    const result = await deployment.deploy(gameId, fields);
    try { return { ...result, settings: await store.save(settings) }; }
    catch { throw new Error('XXMI 文件与路径已部署，但管理器配置保存失败。请检查数据目录权限并手动保存路径。'); }
  });
  handle('xxmi:sync', async input => {
    await environment.assertReady(validateSettings(input).selectedGame,true);
    const settings = await gameConfiguration(input); const result = await syncXXMIPaths(settings.selectedGame, settings.games[settings.selectedGame]);
    try { return { ...result, settings: await store.save(settings) }; }
    catch { throw new Error('XXMI 路径已同步，但管理器配置保存失败。原外部配置备份仍在，请检查数据目录权限后保存。'); }
  });
  handle('directory:choose', async (current: unknown) => {
    const selected = await dialog.showOpenDialog(window!, { title: '选择目录', defaultPath: typeof current === 'string' && current ? current : undefined, properties: ['openDirectory'] });
    return selected.canceled ? null : selected.filePaths[0] ?? null;
  });
  window = new BrowserWindow({
    title: 'Kiriu Mod Manager', width: 1180, height: 900, minWidth: 900, minHeight: 680,
    backgroundColor: '#1a1e27', show: false, titleBarStyle:'hidden',
    ...(process.platform!=='darwin'?{titleBarOverlay:{color:'#1a1e27',symbolColor:'#f4f1ea',height:32}}:{}),
    icon:path.join(app.getAppPath(),'assets','app.ico'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  modBrowser=new ModBrowser({window,cache:path.join(app.getPath('userData'),'mod-downloads'),root:async game=>(await store.read()).games[game].modsDirectory,plan:(file,root,binding,target)=>mutation(()=>target?mods.updateInstallPlan(binding.gameId,file,root,binding,target):mods.downloadInstallPlan(binding.gameId,file,root,binding)),install:(file,root,binding,destinations,target)=>mutation(async()=>{if(quitting||preparingUpdateInstall||updater.status.stage==='installing')throw new Error('程序正在退出或安装更新，Mod 压缩包已保留。');try{if(target){const plan=await mods.updateInstallPlan(binding.gameId,file,root,binding,target);const record=(await mods.context(binding.gameId,target.modId)).record!;const choice=await dialog.showMessageBox(window!,{type:'warning',title:'确认替换 Mod',message:'用候选包替换 '+record.relativePath+'？',detail:'版本：'+(record.provenance?.version||'未知')+' → '+(binding.version||'未知')+'\n选择一个包内条目，新 INI 使用新包配置，原完整内容与配置关联先保留副本。收藏、标签、名称、角色位置保持；当前启停状态保持。活动配置将重新捕获此 Mod，其它配置须重新适配。',buttons:['取消','确认替换'],defaultId:0,cancelId:0});if(choice.response!==1)throw new Error('已取消替换，完整下载包保留。');return await operationLog.run('mods:install-download',[binding.gameId],async()=>{try{return await mods.installUpdate(binding.gameId,file,root,binding,target,destinations);}catch(error){if(!(error instanceof DependencyError)||error.details.issues.some(i=>i.severity==='block'))throw error;const choice=await dialog.showMessageBox(window!,{type:'warning',title:'更新依赖提示',message:error.message,buttons:['取消','接受本次提示'],defaultId:0,cancelId:0});if(choice.response!==1)throw new Error('已取消，下载包保留。');return mods.installUpdate(binding.gameId,file,root,binding,target,destinations,{token:error.details.token,acceptWarnings:true});}},'browser');}return await operationLog.run('mods:install-download',[binding.gameId],()=>mods.installDownload(binding.gameId,file,root,binding,destinations),'browser');}finally{await broadcast();}}),canStart:()=>!quitting&&!preparingUpdateInstall&&updater.status.stage!=='installing',confirmRoot:async(oldRoot,newRoot)=>{const choice=await dialog.showMessageBox(window!,{type:'question',title:'选择 Mod 安装目录',message:'将此任务改用当前已保存的 Mod 根目录？',detail:`任务原目录：${oldRoot||'未配置'}\n当前目录：${newRoot||'未配置'}\n确认后仍需在下载页面点击安装，不移动已有 Mod。`,buttons:['取消','使用当前目录'],defaultId:0,cancelId:0});return choice.response===1;}});
  await modBrowser.initialize();
  window.on('close',event=>{if(!quitting&&tray&&closeToTray){event.preventDefault();window?.hide();}});
  window.once('ready-to-show', () => { window?.show(); });
  window.on('closed', () => { window = null; floatingWindow?.close(); app.quit(); });
  try{const image=nativeImage.createFromPath(path.join(app.getAppPath(),'assets','tray.png'));if(image.isEmpty())throw new Error('Tray icon missing');tray=new Tray(image);tray.setToolTip('Kiriu Mod Manager · 本地 Mod 管理');tray.on('double-click',showMain);await updateTray();}catch{tray=null;closeToTray=false;}
  await loadWindow(window);
  await applicationLog.record('lifecycle','session.window-ready',{webContentsId:window.webContents.id});
  // A restarted update must expose its loaded window even if ready-to-show is delayed.
  window?.show();
  if(process.env.KMM_UPDATE_JOB){for(let i=0;i<100&&window&&!window.isVisible();i++)await new Promise(resolve=>setTimeout(resolve,50));if(window?.isVisible())await acknowledgeUpdate(process.execPath,app.getVersion(),path.join(app.getPath('userData'),'app-updates'));}
}).catch(error => {applicationLog?.fatalSync('startup.failed',error);console.error('应用启动失败:', error.message);app.quit();});
app.on('window-all-closed', () => app.quit());



