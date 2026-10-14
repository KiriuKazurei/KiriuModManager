import {app,BrowserWindow,WebContentsView,session,shell,safeStorage} from 'electron';
import path from 'node:path';
import type {DownloadItem,Event,WebContents} from 'electron';
import type {GameId,ModBrowserBounds,ModBrowserStatus,ModDownloadAction,ModInstallDestination,ModUpdateTarget} from '../shared/contracts';
import {GAMES,MOD_MARKET_URLS} from '../shared/contracts';
import {gameBananaUrl,submissionId} from './gamebanana';
import {ModDownloads} from './mod-downloads';
import type {ModDownloadOptions} from './mod-downloads';
import {validateWebUrl} from './web-links';
import {GameBananaCookies} from './gamebanana-cookies';

export class ModBrowser {
 private view:WebContentsView|null=null;
 private attached=false;
 private game:GameId='zzz';
 private error='';
 private externalUrl='';
 private closed=false;
 private closing:Promise<void>|null=null;
 private browserSession:Electron.Session;
 private cookies:GameBananaCookies;
 private downloads:ModDownloads;
 private retries=new Map<string,{modId:number;gameId:GameId;target?:ModUpdateTarget}>();
 private origins=new Map<string,{modId:number;gameId:GameId}>();
 constructor(private options:Omit<ModDownloadOptions,'fetch'|'requestDownload'|'showFile'>&{window:BrowserWindow}){
  this.browserSession=session.fromPartition('persist:kmm-gamebanana');
  this.cookies=new GameBananaCookies(this.browserSession.cookies,path.join(app.getPath('userData'),'gamebanana-session-cookies.json'),safeStorage);
  this.downloads=new ModDownloads({...options,fetch:(url,init)=>this.browserSession.fetch(url instanceof URL?url.href:url,init),requestDownload:(modId,url,gameId,target)=>{const view=this.createView();this.retries.set(url,{modId,gameId,target});view.webContents.downloadURL(url);},showFile:file=>shell.showItemInFolder(file)});
  this.browserSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  this.browserSession.setPermissionCheckHandler(()=>false);
  this.browserSession.on('will-download',this.onDownload);
  this.browserSession.webRequest.onBeforeRequest((details,callback)=>{
   if(details.resourceType==='mainFrame'){try{gameBananaUrl(details.url,true);}catch{callback({cancel:true});return;}}
   // This session belongs only to the browser; download-attribute requests can omit webContentsId.
   if(/^https:\/\/(?:www\.)?gamebanana\.com\/dl\/[1-9]\d*(?:[/?]|$)/.test(details.url)){
    const modId=submissionId(details.referrer)||submissionId(details.frame?.url||'')||submissionId(this.view?.webContents.getURL()||'');
    if(modId)this.origins.set(details.url,{modId,gameId:this.documentGame()});
   }
   callback({});
  });
  options.window.on('closed',()=>{void this.close();});
 }
 async initialize(){await this.cookies.initialize();await this.downloads.initialize();}
 status():ModBrowserStatus {
  const contents=this.view?.webContents;
  return {gameId:this.game,url:contents&&!contents.isDestroyed()?contents.getURL():'',loading:!!contents&&!contents.isDestroyed()&&contents.isLoadingMainFrame(),canGoBack:!!contents&&!contents.isDestroyed()&&contents.navigationHistory.canGoBack(),canGoForward:!!contents&&!contents.isDestroyed()&&contents.navigationHistory.canGoForward(),error:this.error||this.cookies.error||this.downloads.error,externalUrl:this.externalUrl,downloads:this.downloads.status()};
 }
 hasActiveDownloads(){return this.downloads.hasActive();}
 private navigation(url:string){
  try{gameBananaUrl(url,true);return true;}catch{
   try{const safe=validateWebUrl(url);if(new URL(safe).protocol==='https:'){this.externalUrl=safe;this.error='外站链接请使用工具栏的“打开外部链接”，下载后可手动导入。';}else this.error='不支持此网页地址。';}catch{this.error='已阻止不支持的网页地址。';}
   return false;
  }
 }
 private createView(){
  if(this.closed)throw new Error('内置浏览器已关闭。');if(this.view)return this.view;
  const view=new WebContentsView({webPreferences:{session:this.browserSession,contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true,allowRunningInsecureContent:false}});
  this.view=view;const contents=view.webContents;
  contents.on('will-navigate',(event,url)=>{if(!this.navigation(url))event.preventDefault();});
  contents.on('will-redirect',event=>{if(event.isMainFrame&&!this.navigation(event.url))event.preventDefault();});
  contents.on('will-attach-webview',event=>event.preventDefault());
  contents.setWindowOpenHandler(({url})=>{if(this.navigation(url))this.load(url);return {action:'deny'};});
  contents.on('did-start-loading',()=>{this.error='';this.externalUrl='';});
  contents.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3)this.error='网页加载失败：'+description+'。可点击刷新重试。';});
  contents.on('render-process-gone',()=>{this.error='网页进程已退出，可点击刷新重新载入。';});
  this.load(MOD_MARKET_URLS[this.game]!);return view;
 }
 private load(url:string){void this.view!.webContents.loadURL(url).catch(e=>{if(e.code!=='ERR_ABORTED'&&!this.closed)this.error=e.message;});}
 private selectView(game:GameId){
  const changed=this.game!==game;this.game=game;
  if(!this.view)this.createView();else if(changed)this.load(MOD_MARKET_URLS[game]!);
 }
 private documentGame():GameId {
  const history=this.view?.webContents.navigationHistory;const entries=history?.getAllEntries()||[];
  for(let index=history?.getActiveIndex()??-1;index>=0;index--){
   const match=new URL(entries[index].url).pathname.match(/^\/games\/(19567|21842)(?:\/|$)/);
   if(match)return match[1]==='19567'?'zzz':'endfield';
  }
  return this.game;
 }
 setView(game:GameId,bounds:ModBrowserBounds|null){
  if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');
  if(bounds!==null&&(!bounds||typeof bounds!=='object'||Object.keys(bounds).some(key=>!['x','y','width','height'].includes(key))||['x','y','width','height'].some(key=>!Number.isFinite(bounds[key as keyof ModBrowserBounds])||Math.abs(bounds[key as keyof ModBrowserBounds])>100000)))throw new Error('浏览器区域无效。');
  if(!bounds||!MOD_MARKET_URLS[game]){if(this.game===game&&this.view&&this.attached){this.options.window.contentView.removeChildView(this.view);this.attached=false;}return this.status();}
  this.selectView(game);const [width,height]=this.options.window.getContentSize();const zoom=this.options.window.webContents.getZoomFactor();
  const x=Math.max(0,Math.min(width,Math.round(bounds.x*zoom))),y=Math.max(0,Math.min(height,Math.round(bounds.y*zoom)));
  this.view!.setBounds({x,y,width:Math.max(0,Math.min(width-x,Math.round(bounds.width*zoom))),height:Math.max(0,Math.min(height-y,Math.round(bounds.height*zoom)))});
  if(!this.attached){this.options.window.contentView.addChildView(this.view!);this.attached=true;}
  return this.status();
 }
 async navigate(action:'back'|'forward'|'reload'|'home'|'external',game:GameId=this.game){
  if(!['back','forward','reload','home','external'].includes(action))throw new Error('浏览器操作无效。');
  if(!Object.hasOwn(GAMES,game)||!MOD_MARKET_URLS[game])throw new Error('未配置该游戏网页。');this.selectView(game);
  if(action==='external'){
   const url=this.externalUrl;if(!url||new URL(validateWebUrl(url)).protocol!=='https:')throw new Error('没有可打开的外部 HTTPS 链接。');
   await shell.openExternal(url);this.externalUrl='';this.error='外部网页打开请求已提交；该网站的下载请手动导入。';return this.status();
  }
  const contents=this.view!.webContents;this.error='';this.externalUrl='';
  if(action==='home')this.load(MOD_MARKET_URLS[game]!);
  else if(action==='reload')contents.reload();
  else if(action==='back'&&contents.navigationHistory.canGoBack())contents.navigationHistory.goBack();
  else if(action==='forward'&&contents.navigationHistory.canGoForward())contents.navigationHistory.goForward();
  return this.status();
 }
 fetch=(url:Parameters<typeof fetch>[0],options?:Parameters<typeof fetch>[1])=>this.browserSession.fetch(url instanceof URL?url.href:typeof url==='string'?url:url.url,options);
 queueUpdate(binding:import('./gamebanana').GameBananaDownload,target:ModUpdateTarget){if(this.retries.has(binding.remote.downloadUrl))throw new Error('此文件已经等待下载事件。');const view=this.createView();this.retries.set(binding.remote.downloadUrl,{modId:binding.remote.modId,gameId:binding.gameId,target});view.webContents.downloadURL(binding.remote.downloadUrl);return this.status();}
 installPlan(id:string){return this.downloads.installPlan(id);}
 async downloadAction(id:string,action:ModDownloadAction,destinations?:ModInstallDestination[]){await this.downloads.action(id,action,destinations);return this.status();}
 private onDownload=(event:Event,item:DownloadItem,contents:WebContents)=>{
  if(this.closed){event.preventDefault();return;}
  if(contents!==this.view?.webContents){event.preventDefault();return;}
  const urls=item.getURLChain();const retry=urls.find(url=>this.retries.has(url));
  const origin=urls.find(url=>this.origins.has(url));
  const updateTarget=retry?this.retries.get(retry)?.target:undefined;const source=retry?this.retries.get(retry):origin?this.origins.get(origin):undefined;const modId=source?.modId||submissionId(contents.getURL());if(retry)this.retries.delete(retry);if(origin)this.origins.delete(origin);
  try{this.downloads.accept(item,modId||0,urls,source?.gameId||this.documentGame(),updateTarget);}catch(e){event.preventDefault();this.error=(e as Error).message;}
 };
 close(){
  if(this.closing)return this.closing;this.closed=true;
  this.browserSession.removeListener('will-download',this.onDownload);
  this.closing=this.downloads.close().finally(async()=>{if(this.view&&!this.view.webContents.isDestroyed())this.view.webContents.close();this.view=null;await this.cookies.close();this.browserSession.flushStorageData();});return this.closing;
 }
}
