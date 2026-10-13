import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const parent=path.resolve('.run-data/window-chrome-smoke');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-'));const data=path.join(run,'data');
const settings={version:1,selectedGame:'zzz',games:{},desktop:{marketUrl:'',updateUrl:'https://example.org/releases/{gameId}',closeToTray:false}};
for(const game of ['zzz','endfield']){settings.games[game]={xxmiRoot:'',gameDirectory:'',modsDirectory:path.join(run,game,'Mods')};await fs.mkdir(settings.games[game].modsDirectory,{recursive:true});}await fs.mkdir(data);await fs.writeFile(path.join(data,'settings.json'),JSON.stringify(settings));
const env={...process.env,KMM_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;delete env.KMM_DEV_URL;delete env.KMM_UPDATE_JOB;
let app,page;const checks=[],errors=[];
async function runtime(work,args){return app.evaluate(({app},{work,args})=>{const req=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json');return Function('state','args','return ('+work+')(state,args)')(req(app.getAppPath()+'/dist/main/index.js').desktopRuntime(),args);},{work:work.toString(),args});}
async function until(check){const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error('Window chrome check timed out');await new Promise(resolve=>setTimeout(resolve,30));}}
async function nav(label){await page.getByRole('navigation',{name:'主要导航',exact:true}).getByRole('button',{name:label,exact:true}).click();}
async function theme(value){const current=await page.evaluate(()=>document.documentElement.dataset.theme);if(current!==value)await page.getByRole('button',{name:value==='day'?'切换到日间':'切换到夜间',exact:true}).click();await until(async()=>await runtime((state,value)=>state.window.getBackgroundColor().toLowerCase().includes(value==='day'?'e4e8f0':'1a1e27'),value));}
async function captureNative(name){
 const target=await runtime(state=>{const bytes=state.window.getNativeWindowHandle();if(state.window.isMinimized())state.window.restore();state.window.show();state.window.focus();return {handle:String(bytes.length===8?bytes.readBigUInt64LE():bytes.readUInt32LE()),pid:process.pid};});
 await page.waitForFunction(()=>document.visibilityState==='visible');await page.waitForTimeout(200);
 const file=path.join(run,'capture.ps1');await fs.writeFile(file,`param([long]$Window,[uint32]$ExpectedPid,[string]$OutputFile)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class CaptionCapture {
[StructLayout(LayoutKind.Sequential)]public struct RECT{public int left,top,right,bottom;}
[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr window,out RECT rect);
[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
[DllImport("user32.dll")]public static extern IntPtr SendMessage(IntPtr window,uint msg,IntPtr wParam,IntPtr lParam);
}
'@
[void][CaptionCapture]::SetProcessDPIAware();$target=[IntPtr]$Window;$actual=[uint32]0
[void][CaptionCapture]::GetWindowThreadProcessId($target,[ref]$actual);if($actual -ne $ExpectedPid){throw 'Unexpected window owner'}
if([CaptionCapture]::GetForegroundWindow() -ne $target){throw 'Test window is obscured; no desktop screenshot captured'}
$rect=New-Object CaptionCapture+RECT;if(-not [CaptionCapture]::GetWindowRect($target,[ref]$rect)){throw 'Missing test window'}
$bitmap=New-Object System.Drawing.Bitmap ($rect.right-$rect.left),($rect.bottom-$rect.top);$graphics=[System.Drawing.Graphics]::FromImage($bitmap)
try{$graphics.CopyFromScreen($rect.left,$rect.top,0,0,$bitmap.Size);$bitmap.Save($OutputFile,[System.Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}
$pointX=$rect.left+200;$pointY=$rect.top+28;$packed=[IntPtr](($pointY -shl 16) -bor ($pointX -band 65535))
$hit=[CaptionCapture]::SendMessage($target,0x84,[IntPtr]::Zero,$packed).ToInt32()
@{captionHit=$hit;left=$rect.left;top=$rect.top;width=$rect.right-$rect.left;height=$rect.bottom-$rect.top}|ConvertTo-Json -Compress
`);
 const result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file,'-Window',target.handle,'-ExpectedPid',String(target.pid),'-OutputFile',path.join(run,name)],{windowsHide:true});
 const geometry=JSON.parse(result.stdout.trim());assert.equal(geometry.captionHit,2,'Native hit test must recognize the blank title strip as draggable caption');return geometry;
}
try{
 app=await electron.launch({args:['.'],cwd:process.cwd(),env});page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));await page.getByRole('button',{name:'设置',exact:true}).waitFor();
 await app.evaluate(({session,shell})=>{globalThis.__openedLinks=[];shell.openExternal=async url=>{globalThis.__openedLinks.push(url);};session.fromPartition('persist:kmm-gamebanana').protocol.handle('https',()=>new Response('<!doctype html><h1>浏览器标题栏布局样本</h1>',{headers:{'content-type':'text/html'}}));});
 await runtime(state=>{globalThis.__overlayCalls=[];const original=state.window.setTitleBarOverlay.bind(state.window);state.window.setTitleBarOverlay=options=>{globalThis.__overlayCalls.push(options);return original(options);};});
 assert.equal(await page.locator('.workspace-bar').getByRole('button',{name:'请求刷新',exact:true}).count(),0);assert.equal(await page.locator('.workspace-bar').getByText('更多',{exact:true}).count(),0);
 await theme('night');for(const value of ['day','night']){await theme(value);const style=await page.locator('.window-titlebar').evaluate(element=>({background:getComputedStyle(element).backgroundColor,drag:getComputedStyle(element).getPropertyValue('-webkit-app-region'),text:element.innerText}));assert.equal(style.text,'');assert.equal(style.drag,'drag');assert.equal(style.background,value==='day'?'rgb(228, 232, 240)':'rgb(26, 30, 39)');checks.push({theme:value,style,geometry:await captureNative('main-'+value+'.png')});}
 const calls=await app.evaluate(()=>globalThis.__overlayCalls);assert.ok(calls.some(row=>row.color==='#e4e8f0'&&row.symbolColor==='#16181e'));assert.ok(calls.some(row=>row.color==='#1a1e27'&&row.symbolColor==='#f4f1ea'));
 const before=await runtime(state=>state.window.getBackgroundColor());const invalid=await page.evaluate(()=>window.kmm.setWindowTheme('invalid'));assert.equal(invalid.ok,false);assert.equal(await runtime(state=>state.window.getBackgroundColor()),before);
 await theme('day');await page.getByRole('button',{name:'设置',exact:true}).click();const shortcuts=page.locator('.settings-shortcuts');for(const label of ['请求刷新','打开 Mod 网页','打开更新发布页','退出管理器'])await shortcuts.getByRole('button',{name:label,exact:true}).waitFor();
 await shortcuts.getByRole('button',{name:'请求刷新',exact:true}).click();await page.locator('.shell-error.error').waitFor();assert.match(await page.locator('.shell-error.error').innerText(),/XXMI|loader|目录/);
 await shortcuts.getByRole('button',{name:'打开更新发布页',exact:true}).click();await until(async()=>(await app.evaluate(()=>globalThis.__openedLinks)).length===1);assert.deepEqual(await app.evaluate(()=>globalThis.__openedLinks),['https://example.org/releases/zzz']);await captureNative('settings-day.png');
 await shortcuts.getByRole('button',{name:'打开 Mod 网页',exact:true}).click();await page.locator('.market-viewport').waitFor();await until(async()=>{const rect=await page.locator('.market-viewport').boundingBox();const bounds=await runtime(state=>state.modBrowser.view.getBounds());return Math.abs(rect.y-bounds.y)<=1&&Math.abs(rect.height-bounds.height)<=1;});assert.ok((await page.locator('.market-viewport').boundingBox()).y>32);
 await page.getByRole('button',{name:'折叠侧边栏',exact:true}).click();await page.getByRole('button',{name:'展开侧边栏',exact:true}).click();await nav('下载进度');await until(async()=>await runtime(state=>!state.modBrowser.attached));
 checks.push({shortcuts:'all moved; refresh rejects missing fixture loader; update opens expected context via stub; Mod web navigates normally; native browser bounds and page hiding preserved'});
 await page.getByRole('button',{name:'设置',exact:true}).click();assert.deepEqual(errors,[]);const closed=app.waitForEvent('close');await shortcuts.getByRole('button',{name:'退出管理器',exact:true}).click();await closed;app=null;checks.push({quit:'settings button gracefully exits the actual isolated app'});
 await fs.writeFile(path.join(run,'report.json'),JSON.stringify({pass:true,run,checks,errors,scope:'source UI; native Windows screenshot and caption hit test; actual theme setter; external link stub and no loader/game launched'},null,2));console.log(JSON.stringify({pass:true,run,checks}));
}catch(error){await fs.writeFile(path.join(run,'report.json'),JSON.stringify({pass:false,run,checks,errors,error:error.stack},null,2));console.error(error);process.exitCode=1;}
finally{if(app)await app.close().catch(()=>{});}
