import { app, BrowserWindow, dialog, ipcMain, IpcMainInvokeEvent, net, shell, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SettingsStore, validateSettings, mergeGamePaths, mergeDesktopPreferences } from './settings';
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
export function desktopRuntime(){return {window,floatingWindow,tray,trayMenu};}
const singleton=app.requestSingleInstanceLock();
if(!singleton)app.quit();
app.on('second-instance',()=>{if(window?.isMinimized())window.restore();window?.show();window?.focus();});
app.on('before-quit',()=>{quitting=true;tray?.destroy();tray=null;});
app.whenReady().then(async () => {
  if(!singleton)return;
  const store = new SettingsStore(app.getPath('userData'));
  const mods = new ModService(app.getPath('userData'), async game => (await store.read()).games[game]);
  const business=new BusinessService(app.getPath('userData'),mods,store);
  const ini=new IniService(mods,business.recovery);
  const characterCovers=new CharacterCoverService(app.getPath('userData'),path.join(app.getAppPath(),'assets','character-covers'),mods,bytes=>!nativeImage.createFromBuffer(bytes).isEmpty());
  const deployment = new DeploymentService({ fetch: (url, options) => net.fetch(url, options), cacheDirectory: path.join(app.getPath('userData'), 'downloads'), checkRuntime: () => checkRuntime() });
  const updater=new AppUpdater({fetch:(url,options)=>net.fetch(url,options),currentVersion:app.getVersion(),cacheDirectory:path.join(app.getPath('userData'),'app-updates'),installRoot:path.dirname(process.execPath),packaged:app.isPackaged,helperPath:path.join(app.getAppPath(),'assets','update-helper.ps1'),protectedPaths:async()=>{const settings=await store.read();return [app.getPath('userData'),...Object.values(settings.games).flatMap(game=>Object.values(game))];}});
  const updateSource=async()=>(await store.read()).desktop?.updateSourceUrl??DEFAULT_APP_UPDATE_SOURCE;
  let pending:Promise<unknown>=Promise.resolve();
  const mutation=<T>(work:()=>Promise<T>):Promise<T>=>{const task=pending.then(work);pending=task.catch(()=>{});return task;};
  const showMain=()=>{window?.show();if(window?.isMinimized())window.restore();window?.focus();};
  const broadcast=async(settingsChanged=false)=>{const settings=await store.read();for(const target of [window,floatingWindow])if(target&&!target.isDestroyed())target.webContents.send('desktop:changed',{gameId:settings.selectedGame,settingsChanged});};
  const trustedDocuments=new WeakMap<BrowserWindow,string>();
  const documentUrl=(value:string)=>{try{const url=new URL(value);url.hash='';return url.href;}catch{return '';}};
  const loadWindow=async(target:BrowserWindow,floating=false)=>{
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
  const responsiveChannels=new Set(['desktop:status','desktop:floating','desktop:show','desktop:quit','deployment:progress','runtime:check','runtime:download','directory:choose','update:status','update:check','update:download']);
  const handle = <C extends IPCChannel>(channel:C, work:(...args:IPCArguments<C>)=>Promise<IPCValue<C>>) => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<Result<IPCValue<C>>> => {
      const sender=[window,floatingWindow].find(target=>target&&!target.isDestroyed()&&event.sender===target.webContents);
      if (!sender || event.senderFrame !== sender.webContents.mainFrame || documentUrl(event.senderFrame.url)!==trustedDocuments.get(sender)) return { ok: false, error: '此页面无权访问桌面接口。' };
      const run=async():Promise<Result<IPCValue<C>>>=>{
      if(updater.status.stage==='installing'&&!['update:status','desktop:status','desktop:show','desktop:quit'].includes(channel))return {ok:false,error:'正在退出并安装更新，请等待重新打开。'};
      try { const value=await work(...args as IPCArguments<C>);if(/^(settings:(save|save-game-paths|save-desktop-preferences)|mods:(operate|import|replace|delete|choose-cover|group)|presets:(save|delete|apply)|ini:save|recovery:(create|restore)|xxmi:(deploy|sync))$/.test(channel)){await broadcast(/^(settings:(save|save-game-paths|save-desktop-preferences)|recovery:restore|xxmi:(deploy|sync))$/.test(channel));await updateTray();}return { ok: true, value }; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const errorText = code ? `目录操作失败（${code}），请检查路径和权限。` : (error as Error).message;
        return { ok: false, error: errorText || '操作失败，请检查路径和权限。' };
      }
      };
      return responsiveChannels.has(channel)?run():mutation(run);
    });
  };
  handle('settings:read', () => store.read());
  handle('update:check',async()=>updater.check(await updateSource()));
  handle('update:status',()=>updater.readStatus());
  handle('update:download',async()=>{
    const source=await updateSource();return updater.download(source,async release=>{const choice=await dialog.showMessageBox(window!,{type:'question',title:'下载管理器更新',message:`下载 ${release.version}？`,detail:`更新来源：${source}\n大小：${(release.size/1024**2).toFixed(1)} MiB\n\n${release.notes}`,buttons:['取消','下载更新'],defaultId:0,cancelId:0});if(choice.response===1&&source!==await updateSource())throw new Error('更新源已改变，请重新检查。');return choice.response===1;});
  });
  handle('update:install',async()=>{
    const source=await updateSource();const result=await updater.install(source,async release=>{const choice=await dialog.showMessageBox(window!,{type:'warning',title:'安装管理器更新',message:`退出并安装 ${release.version}？`,detail:'请先保存所有未提交的编辑。程序将退出、替换完整便携目录并重新打开。用户数据和 Mod 文件保持；旧程序目录保留作回退副本。',buttons:['取消','退出并安装'],defaultId:0,cancelId:0});if(choice.response===1&&source!==await updateSource())throw new Error('更新源已改变，请重新检查。');return choice.response===1;});if(result)setTimeout(()=>app.quit(),250);return result;
  });
  handle('desktop:status',async()=>({trayAvailable:!!tray&&!tray.isDestroyed(),floatingVisible:!!floatingWindow&&floatingWindow.isVisible(),version:app.getVersion()}));
  handle('desktop:floating',(visible:boolean)=>toggleFloating(visible));
  handle('desktop:show',async()=>showMain());
  handle('desktop:quit',async()=>{setImmediate(()=>app.quit());});
  handle('desktop:game',(game:GameId)=>chooseGame(game));
  handle('desktop:launch',async (game:GameId,mode:'gui'|'game')=>{const settings=await store.read();if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');const plan=await launchPlan(game,settings.games[game],mode);await spawnLauncher(plan);return mode==='gui'?'XXMI 打开请求已提交，请检查 Launcher 窗口。':'XXMI 启动请求已提交；不代表游戏或 Mod 已加载，请检查游戏窗口。';});
  handle('desktop:refresh',async (game:GameId)=>{const settings=await store.read();if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');const installation=await inspectXXMI(game,settings.games[game].xxmiRoot);if(!installation.installed)throw new Error('所选 loader 未安装，无法确认刷新键。');const executables=await gameExecutables(game,settings.games[game].gameDirectory);const key=await refreshKey(installation.iniPath);const sent=await sendRefresh(path.join(app.getAppPath(),'assets','refresh-helper.ps1'),executables,key.virtualKey);return `${key.name} 刷新请求已发送到所选游戏窗口（PID ${sent.pid}）。${key.defaultKey?'未找到自定义配置，使用默认 F10。':''}请在游戏中确认效果。`;});
  handle('desktop:link',async (game:GameId,kind:'market'|'update')=>{const settings=await store.read();const url=resolveWebUrl(kind==='market'?settings.desktop?.marketUrl||'':settings.desktop?.updateUrl||'',game,kind);if(!url)throw new Error(kind==='market'?'尚未配置 Mod 网页入口，请在路径与加载器设置地址。':'尚未配置更新发布页，当前没有已发布版本或自动更新来源。');await shell.openExternal(url);return '网页打开请求已提交到默认浏览器。';});
  handle('presets:list',(game:GameId)=>business.presets(game));
  handle('presets:save',(game:GameId,id:string|null,name:string,members:Record<string,boolean>|null)=>business.savePreset(game,id,name,members));
  handle('presets:delete',(game:GameId,id:string)=>business.deletePreset(game,id));
  handle('presets:apply',(game:GameId,id:string)=>business.applyPreset(game,id));
  handle('ini:list',(game:GameId,id:string)=>ini.files(game,id));
  handle('ini:read',(game:GameId,id:string,file:string)=>ini.read(game,id,file));
  handle('ini:save',(game:GameId,id:string,file:string,digest:string,edit)=>ini.save(game,id,file,digest,edit));
  handle('conflicts:scan',(game:GameId)=>ini.conflicts(game));
  handle('recovery:list',(game:GameId)=>business.recovery.list(game));
  handle('recovery:create',(game:GameId,name:string)=>business.createBackup(game,name));
  handle('recovery:restore',async (game:GameId,id:string)=>{const {record}=await business.restoreInfo(game,id);const choice=await dialog.showMessageBox(window!,{type:'warning',title:'恢复本地备份',message:`恢复“${record.name}”？`,detail:record.kind==='snapshot'?`将恢复当前游戏的全部 Mod 内容、角色封面、元数据、预设及管理器游戏路径。Mod 根：${record.root}。现有内容先保存自动副本；旧快照没有自定义角色封面时恢复默认封面；其它游戏保留。恢复后重新读取设置，不同步外部XXMI配置。`:`将恢复${record.kind==='ini'?'INI文本':'Mod 内容、信息与保存时的停用状态'}：${record.relativePath||record.name}。当前同身份文件与目标内容先留恢复副本；其它 Mod 保留。`,buttons:['取消','恢复'],defaultId:0,cancelId:0});return choice.response===1?business.restore(game,id):null;});
  handle('settings:save', input => store.save(input));
  handle('settings:save-game-paths',async(game,patch)=>store.save(mergeGamePaths(await store.read(),game,patch)));
  handle('settings:save-desktop-preferences',async patch=>store.save(mergeDesktopPreferences(await store.read(),patch)));
  handle('xxmi:inspect', (game: GameId, root: string) => inspectXXMI(game, root));
  handle('mods:scan', (game: GameId) => mods.scan(game));
  handle('mods:operate', (game: GameId, id: string, operation: ModOperation) => mods.operate(game,id,operation));
  handle('mods:cover', (game: GameId,id: string) => mods.cover(game,id));
  handle('characters:covers',(game:GameId)=>characterCovers.read(game));
  handle('characters:choose-cover',async (game:GameId,name:string)=>{const source=await dialog.showOpenDialog(window!,{title:'选择角色文件夹封面',properties:['openFile'],filters:[{name:'PNG / JPEG 图片',extensions:['png','jpg','jpeg']}]});if(source.canceled)return null;const result=await characterCovers.choose(game,name,source.filePaths[0]);await broadcast();return result;});
  handle('mods:group', (game: GameId,kind: 'category'|'character'|'appearance',name: string) => mods.addGroup(game,kind,name));
  const selectSource = async (kind: 'folder'|'archive', multiple: boolean) => {
    if (!['folder','archive'].includes(kind)) throw new Error('导入类型无效。');
    return dialog.showOpenDialog(window!, { title:kind==='folder'?'选择本地 Mod 文件夹':'选择 Mod 压缩包', properties:kind==='folder'?(multiple?['openDirectory','multiSelections']:['openDirectory']):(multiple?['openFile','multiSelections']:['openFile']), filters:kind==='archive'?[{name:'Mod 压缩包',extensions:['zip','7z','rar']}]:undefined });
  };
  handle('mods:import', async (game: GameId,kind: 'folder'|'archive') => {
    const source=await selectSource(kind,true); if(source.canceled) return {library:await mods.scan(game),importedIds:[],errors:[],canceled:true}; return mods.import(game,source.filePaths);
  });
  handle('mods:replace', async (game:GameId,id:string,kind:'folder'|'archive') => {
    const source=await selectSource(kind,false); return source.canceled?null:mods.replace(game,id,source.filePaths[0]);
  });
  handle('mods:delete', async (game:GameId,id:string) => {
    const snapshot=await mods.scan(game); const target=snapshot.mods.find(mod=>mod.id===id); if(!target) throw new Error('Mod 不存在，请重新扫描。');
    const choice=await dialog.showMessageBox(window!,{type:'warning',title:'移到恢复区',message:`移除“${target.name}”？`,detail:'文件会从 loader 读取目录移除，恢复副本保存在管理器数据目录的 removed 文件夹。不会静默永久删除。',buttons:['取消','移到恢复区'],defaultId:0,cancelId:0});
    return choice.response===1?mods.delete(game,id):null;
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
    const settings = await gameConfiguration(input); const gameId = settings.selectedGame;
    const fields = settings.games[gameId];
    if (!fields.modsDirectory && fields.xxmiRoot) fields.modsDirectory = path.join(fields.xxmiRoot, GAMES[gameId].importer, 'Mods');
    const result = await deployment.deploy(gameId, fields);
    try { return { ...result, settings: await store.save(settings) }; }
    catch { throw new Error('XXMI 文件与路径已部署，但管理器配置保存失败。请检查数据目录权限并手动保存路径。'); }
  });
  handle('xxmi:sync', async input => {
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
    backgroundColor: '#0a0d14', show: false,
    icon:path.join(app.getAppPath(),'assets','app.ico'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.on('close',event=>{if(!quitting&&tray&&closeToTray){event.preventDefault();window?.hide();}});
  window.once('ready-to-show', () => { window?.show(); });
  window.on('closed', () => { window = null; floatingWindow?.close(); app.quit(); });
  try{const image=nativeImage.createFromPath(path.join(app.getAppPath(),'assets','tray.png'));if(image.isEmpty())throw new Error('Tray icon missing');tray=new Tray(image);tray.setToolTip('Kiriu Mod Manager · 本地 Mod 管理');tray.on('double-click',showMain);await updateTray();}catch{tray=null;closeToTray=false;}
  await loadWindow(window);
  // A restarted update must expose its loaded window even if ready-to-show is delayed.
  window?.show();
  if(process.env.KMM_UPDATE_JOB){for(let i=0;i<100&&window&&!window.isVisible();i++)await new Promise(resolve=>setTimeout(resolve,50));if(window?.isVisible())await acknowledgeUpdate(process.execPath,app.getVersion());}
}).catch(error => { console.error('应用启动失败:', error.message); app.quit(); });
app.on('window-all-closed', () => app.quit());



