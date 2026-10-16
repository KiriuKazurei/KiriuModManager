import { promises as fs, createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { assertNoLinks, containedPath, extractZip } from './archive';
import { validateUpdateSource } from './web-links';
import type { AppUpdateRelease, AppUpdateStatus } from '../shared/contracts';
import type { FetchClient } from './releases';
import {logEvent} from './application-log';
import {writeAtomicJson} from './atomic-json';

const MAX_ARCHIVE=512*1024**2;
export function versionParts(value:unknown):number[] {
 if(typeof value!=='string'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))throw new Error('更新版本须为稳定版本号，例如 0.0.1。');
 const parts=value.split('.').map(Number);if(parts.some(n=>!Number.isSafeInteger(n)))throw new Error('更新版本号超出范围。');return parts;
}
export function newerVersion(candidate:string,current:string):boolean {
 const a=versionParts(candidate),b=versionParts(current);for(let i=0;i<3;i++){if(a[i]!==b[i])return a[i]>b[i];}return false;
}
function httpsUrl(value:unknown):string {
 const result=validateUpdateSource(value);if(!result)throw new Error('更新下载地址为空。');return result;
}
async function request(client:FetchClient,url:string,signal:AbortSignal):Promise<Response> {
 for(let i=0;i<6;i++){
  const result=await client(httpsUrl(url),{headers:{'User-Agent':'KiriuModsManager','Accept':'application/vnd.github+json'},redirect:'manual',signal});
  if([301,302,303,307,308].includes(result.status)){const target=result.headers.get('location');await result.body?.cancel();if(!target)throw new Error('更新服务器重定向缺少地址。');url=httpsUrl(new URL(target,url).href);continue;}
  if(!result.ok)throw new Error(result.status===403||result.status===429?'更新服务器限流，请稍后重试。':`更新服务器返回 HTTP ${result.status}。`);
  return result;
 }throw new Error('更新服务器重定向过多。');
}
async function json(client:FetchClient,url:string):Promise<unknown> {
 const result=await request(client,url,AbortSignal.timeout(30000));if(!result.body)throw new Error('更新服务器返回空内容。');
 const chunks:Buffer[]=[];let bytes=0;for await(const chunk of result.body as unknown as AsyncIterable<Uint8Array>){bytes+=chunk.length;if(bytes>256*1024){await result.body.cancel().catch(()=>{});throw new Error('更新清单过大。');}chunks.push(Buffer.from(chunk));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('更新清单不是有效 JSON。');}
}
export function validateUpdateManifest(input:unknown,base:string):AppUpdateRelease {
 const m=input as Record<string,unknown>;
 if(!m||m.schemaVersion!==1||m.product!=='kiriu-mods-manager'||m.platform!=='win32-x64')throw new Error('更新清单产品或平台不匹配。');
 versionParts(m.version);
 if(typeof m.notes!=='string'||m.notes.length>64000||typeof m.publishedAt!=='string'||!Number.isFinite(Date.parse(m.publishedAt)))throw new Error('更新说明或发布日期无效。');
 if(typeof m.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(m.sha256)||!Number.isSafeInteger(m.size)||Number(m.size)<=0||Number(m.size)>MAX_ARCHIVE||typeof m.url!=='string')throw new Error('更新包大小、地址或 SHA256 无效。');
 return {version:m.version as string,notes:m.notes,publishedAt:m.publishedAt,url:httpsUrl(new URL(m.url,base).href),size:Number(m.size),sha256:m.sha256.toLowerCase()};
}
export async function resolveAppUpdate(client:FetchClient,source:string):Promise<AppUpdateRelease> {
 source=httpsUrl(source);const url=new URL(source);
 if(url.hostname==='github.com'){
  const match=/^\/([\w.-]+)\/([\w.-]+?)(?:\/releases(?:\/latest)?)?\/?$/.exec(url.pathname);
  if(!match||url.search)throw new Error('GitHub 更新源请填写仓库主页或 releases/latest 地址。');
  const repo=`${match[1]}/${match[2].replace(/\.git$/,'')}`;
  const release=await json(client,`https://api.github.com/repos/${repo}/releases/latest`) as {tag_name?:string;draft?:boolean;prerelease?:boolean;assets?:{name:string;browser_download_url:string;size:number;digest?:string}[]};
  if(release.draft||release.prerelease||!Array.isArray(release.assets))throw new Error('GitHub 没有可用的稳定发行版。');
  const manifest=release.assets.find(asset=>asset.name==='kmm-update.json');
  const owned=(value:string)=>{const u=new URL(httpsUrl(value));if(u.hostname!=='github.com'||!u.pathname.startsWith(`/${repo}/releases/download/`))throw new Error('更新资产不属于所选 GitHub 仓库。');};
  if(!manifest)throw new Error('发行版缺少 kmm-update.json，请发布完整更新资产。');owned(manifest.browser_download_url);
  const resolved=validateUpdateManifest(await json(client,manifest.browser_download_url),manifest.browser_download_url);owned(resolved.url);
  const asset=release.assets.find(asset=>asset.browser_download_url===resolved.url);
  if(release.tag_name?.replace(/^v/,'')!==resolved.version||!asset||asset.size!==resolved.size||(asset.digest&&asset.digest!==`sha256:${resolved.sha256}`))throw new Error('GitHub 发行版本或资产与更新清单不一致。');
  return resolved;
 }
 return validateUpdateManifest(await json(client,source),source);
}
export async function fileHash(file:string):Promise<string> {
 const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');
}
export async function packageFiles(root:string,allowMods=false):Promise<string[]> {
 const files:string[]=[];
 async function walk(directory:string){await assertNoLinks(directory);for(const item of await fs.readdir(directory,{withFileTypes:true})){const target=path.join(directory,item.name);if(item.isSymbolicLink())throw new Error('程序包包含链接。');if(directory===root&&['mods','log'].includes(item.name.toLowerCase())){if(!allowMods||!item.isDirectory())throw new Error('Mods / log 是保留的用户目录，更新包不能包含或替换它们。');await assertNoLinks(target);continue;}if(item.isDirectory())await walk(target);else if(item.isFile())files.push(path.relative(root,target).replaceAll('\\','/'));else throw new Error('程序包包含特殊文件。');}}
 await walk(root);return files.sort();
}
export async function validateAppPackage(root:string,version:string,allowMods=false):Promise<void> {
 await assertNoLinks(root);const manifestFile=path.join(root,'kmm-package.json');await assertNoLinks(manifestFile);
 const manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
 if(manifest.schemaVersion!==1||manifest.product!=='kiriu-mods-manager'||manifest.platform!=='win32-x64'||manifest.version!==version||!manifest.files||typeof manifest.files!=='object'||Array.isArray(manifest.files))throw new Error('程序包身份或版本不匹配。');
 const actual=(await packageFiles(root,allowMods)).filter(file=>file!=='kmm-package.json');const expected=Object.keys(manifest.files).sort();
 if(expected.some(file=>/^(?:mods|log)(?:[\\/]|$)/i.test(file)))throw new Error('程序清单不能包含保留的 Mods / log 用户目录。');
 if(actual.length>50000||actual.length!==expected.length||actual.some((file,i)=>file!==expected[i]))throw new Error('程序目录包含清单外文件或缺少文件，请先保留个人文件再更新。');
 for(const file of expected){if(!/^[a-f0-9]{64}$/.test(manifest.files[file])||await fileHash(containedPath(root,file))!==manifest.files[file])throw new Error(`程序包文件校验失败：${file}`);}
 for(const file of ['KiriuModsManager.exe','resources/app/package.json','resources/app/dist/main/index.js','resources/app/dist/preload/index.js','resources/app/dist/renderer/index.html','resources/app/assets/update-helper.ps1'])if(!Object.hasOwn(manifest.files,file))throw new Error(`程序包缺少必要文件：${file}`);
 const pkg=JSON.parse(await fs.readFile(path.join(root,'resources/app/package.json'),'utf8'));
 if(pkg.name!=='kiriu-mods-manager'||pkg.version!==version||pkg.main!=='dist/main/index.js')throw new Error('程序包入口或版本不匹配。');
}
function overlaps(a:string,b:string):boolean {const relation=path.relative(path.resolve(a),path.resolve(b));return !relation||(!relation.startsWith('..'+path.sep)&&relation!=='..'&&!path.isAbsolute(relation));}
export function assertUpdateLocation(root:string,protectedPaths:string[]):void {
 if(path.resolve(root)===path.parse(path.resolve(root)).root)throw new Error('不能在磁盘根目录执行便携更新。');
 for(const target of protectedPaths.filter(Boolean))if(overlaps(root,target)||overlaps(target,root))throw new Error('程序目录与用户数据、游戏或 Mod 目录重叠，请先将程序移到独立目录。');
}
interface Dependencies {
 fetch:FetchClient; currentVersion:string; cacheDirectory:string; installRoot:string; packaged:boolean;
 helperPath:string; protectedPaths:()=>Promise<string[]>;
}
export class AppUpdater {
 status:AppUpdateStatus; private busy=false; private source=''; private prepared=''; private transaction='';
 constructor(private readonly d:Dependencies){this.status={stage:'idle',currentVersion:d.currentVersion,percent:0,message:'尚未检查更新。',canInstall:d.packaged&&process.platform==='win32'&&process.arch==='x64'};}
 async readStatus(){
  try{const result=JSON.parse(await fs.readFile(path.join(this.d.cacheDirectory,'last-update.json'),'utf8'));if(typeof result.stage==='string'&&typeof result.message==='string')this.status={...this.status,lastResult:{stage:result.stage,message:result.message,backup:result.backup}};}catch{/* No completed update yet. */}
  return this.status;
 }
 private async work<T>(task:()=>Promise<T>):Promise<T>{if(this.busy)throw new Error('更新任务正在进行，请等待完成。');this.busy=true;try{return await task();}catch(error){this.status={...this.status,stage:'error',message:(error as Error).message};throw error;}finally{this.busy=false;}}
 private progress(stage:AppUpdateStatus['stage'],message:string,percent=0){const changed=this.status.stage!==stage;this.status={...this.status,stage,message,percent};if(changed)void logEvent('updater','update.stage',{stage,percent,currentVersion:this.d.currentVersion,candidateVersion:this.status.release?.version});}
 async check(source:string){return this.work(async()=>{
  this.prepared='';this.source=validateUpdateSource(source);this.status={...this.status,release:undefined};this.progress('checking','正在检查最新稳定版本…');
  if(!this.source)throw new Error('尚未配置更新源，请保存 GitHub 仓库或 HTTPS 更新清单地址。');
  const release=await resolveAppUpdate(this.d.fetch,this.source);this.status={...this.status,release};
  this.progress(newerVersion(release.version,this.d.currentVersion)?'available':'current',newerVersion(release.version,this.d.currentVersion)?`发现新版本 ${release.version}。`:'当前版本已是最新；不会降级。',100);return this.status;
 });}
 async download(source:string,confirm:(release:AppUpdateRelease)=>Promise<boolean>){return this.work(async()=>{
  const release=this.status.release;if(!release||this.source!==source||!newerVersion(release.version,this.d.currentVersion)||!['available','error','ready'].includes(this.status.stage))throw new Error('更新源或状态已改变，请重新检查更新。');
  if(!await confirm(release))return null;
  this.prepared='';this.progress('downloading','正在下载更新包…');
  await assertNoLinks(this.d.cacheDirectory);await fs.mkdir(this.d.cacheDirectory,{recursive:true});
  const cache=await fs.mkdtemp(path.join(this.d.cacheDirectory,'download-'));const archive=path.join(cache,'update.zip');
  const response=await request(this.d.fetch,release.url,AbortSignal.timeout(10*60*1000));if(!response.body)throw new Error('更新包响应为空。');
  let bytes=0;const hash=createHash('sha256');
  await pipeline(Readable.fromWeb(response.body as never),new Transform({transform:(chunk:Buffer,_encoding,done)=>{bytes+=chunk.length;if(bytes>release.size){done(new Error('更新包大小超出清单声明。'));return;}hash.update(chunk);this.progress('downloading',`正在下载更新包：${bytes} / ${release.size} 字节`,Math.floor(bytes/release.size*90));done(null,chunk);}}),createWriteStream(archive,{flags:'wx'}));
  this.progress('verifying','正在校验更新包与程序文件…',90);
  if(bytes!==release.size||hash.digest('hex')!==release.sha256)throw new Error('更新包长度或 SHA256 校验失败；现有程序未修改。');
  if(!this.status.canInstall)throw new Error('更新包已校验；源码运行模式不替换程序，请使用 Windows x64 便携发行包。');
  assertUpdateLocation(this.d.installRoot,await this.d.protectedPaths());await assertNoLinks(this.d.installRoot);
  await fs.mkdir(path.dirname(this.d.installRoot),{recursive:true});this.transaction=await fs.mkdtemp(path.join(path.dirname(this.d.installRoot),'.kmm-update-'));
  const unpacked=path.join(this.transaction,'unpacked');await extractZip(archive,unpacked);
  const entries=await fs.readdir(unpacked,{withFileTypes:true});if(entries.length!==1||!entries[0].isDirectory()||entries[0].name!==`KiriuModsManager-${release.version}-win-x64`)throw new Error('更新 ZIP 须包含唯一的完整便携程序目录。');
  this.prepared=path.join(unpacked,entries[0].name);await validateAppPackage(this.prepared,release.version);
  await fs.copyFile(this.d.helperPath,path.join(this.transaction,'update-helper.ps1'));
  this.progress('ready','更新包校验通过，可以退出并安装。',100);return this.status;
 });}
 async install(source:string,confirm:(release:AppUpdateRelease)=>Promise<boolean>,start:(job:string)=>Promise<void>=startUpdateHelper){return this.work(async()=>{
  const release=this.status.release;if(!this.status.canInstall||!release||!this.prepared||this.source!==source||this.status.stage!=='ready')throw new Error('没有可安装的已验证更新，请重新检查并下载。');
  if(!await confirm(release))return null;
  assertUpdateLocation(this.d.installRoot,await this.d.protectedPaths());await validateAppPackage(this.d.installRoot,this.d.currentVersion,true);await validateAppPackage(this.prepared,release.version);
  const job=path.join(this.transaction,'job.json');
  await fs.writeFile(job,JSON.stringify({schemaVersion:1,pid:process.pid,installRoot:this.d.installRoot,prepared:this.prepared,backup:path.join(path.dirname(this.d.installRoot),`.kmm-previous-${randomUUID()}`),version:release.version,currentVersion:this.d.currentVersion,resultFile:path.join(this.d.cacheDirectory,'last-update.json')},null,2),{flag:'wx'});
  await start(job);this.progress('installing','正在退出，更新完成后将重新打开。',100);return this.status;
 });}
}
export async function startUpdateHelper(job:string):Promise<void> {
 const directory=path.dirname(job);const helper=path.join(directory,'update-helper.ps1');await assertNoLinks(helper);
 const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 const quote=(value:string)=>"'"+value.replace(/'/g,"''")+"'";
 const runner=path.join(directory,'helper-runner.ps1');
 await fs.writeFile(runner,'\ufeff'+`& ${quote(helper)} -JobFile ${quote(job)} *> ${quote(path.join(directory,'helper-output.log'))}`,{flag:'wx'});
 const argumentsText=`-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runner}"`;
 const script=`$ErrorActionPreference='Stop'; $helperProcess=Start-Process -FilePath ${quote(powershell)} -ArgumentList ${quote(argumentsText)} -WorkingDirectory ${quote(directory)} -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText(${quote(path.join(directory,'helper.pid'))},[string]$helperProcess.Id)`;
 const output=await fs.open(path.join(directory,'helper-launch.log'),'wx');
 // A short bootstrap starts the hidden helper independently of Electron's process lifetime.
 const child=spawn(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:directory,env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')},windowsHide:true,stdio:['ignore',output.fd,output.fd]});
 try {await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('spawn',resolve);});}
 finally {await output.close();}
 child.unref();
 // The helper rehashes both complete Electron packages before it is ready to replace anything.
 for(let i=0;i<2400;i++){
  try{const status=JSON.parse(await fs.readFile(path.join(directory,'result.json'),'utf8'));if(status.stage==='waiting')return;if(status.stage==='error')throw new Error(status.message);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  if(child.exitCode!==null&&child.exitCode!==0){
   const status=await fs.readFile(path.join(directory,'result.json'),'utf8').then(text=>JSON.parse(text)).catch(()=>null);
   if(status?.stage==='waiting')return;
   throw new Error(`更新 helper 启动失败（${child.exitCode}），请检查事务目录中的 helper-launch.log。`);
  }
  await new Promise(resolve=>setTimeout(resolve,50));
 }throw new Error('更新 helper 未就绪；程序保持运行，请检查更新日志。');
}
export async function cleanupUpdateBackup(jobFile:string,executable:string,version:string,cacheDirectory:string):Promise<boolean> {
 if(path.basename(jobFile)!=='job.json'||!/^\.kmm-update-[\w-]+$/.test(path.basename(path.dirname(jobFile))))throw new Error('更新事务位置无效。');
 await assertNoLinks(jobFile);
 const input=JSON.parse(await fs.readFile(jobFile,'utf8'));
 const same=(a:string,b:string)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
 if(input.schemaVersion!==1||input.version!==version||!same(path.join(input.installRoot,'KiriuModsManager.exe'),executable)||!same(path.dirname(input.installRoot),path.dirname(path.dirname(jobFile)))||!same(path.dirname(input.backup),path.dirname(input.installRoot))||!/^\.kmm-previous-[a-f0-9-]{36}$/.test(path.basename(input.backup))||!same(input.resultFile,path.join(cacheDirectory,'last-update.json')))throw new Error('更新清理范围与本次安装不一致。');
 const resultFile=path.join(path.dirname(jobFile),'result.json');await assertNoLinks(resultFile);
 const result=JSON.parse(await fs.readFile(resultFile,'utf8'));
 if(result.stage!=='success'||result.version!==version||!same(result.installRoot,input.installRoot))return false;
 await validateAppPackage(input.installRoot,version,true);
 try {await fs.lstat(input.backup);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}
 await validateAppPackage(input.backup,input.currentVersion);
 await assertNoLinks(input.backup);
 await fs.rm(input.backup,{recursive:true});
 const completed={...result,backup:undefined,message:'Update completed and the new window was loaded; previous program removed.'};
 await writeAtomicJson(resultFile,JSON.stringify(completed));
 await writeAtomicJson(input.resultFile,JSON.stringify(completed));
 return true;
}
export async function acknowledgeUpdate(executable:string,version:string,cacheDirectory:string):Promise<void> {
 const job=process.env.KMM_UPDATE_JOB;if(!job)return;delete process.env.KMM_UPDATE_JOB;
 if(path.basename(job)!=='job.json'||!path.basename(path.dirname(job)).startsWith('.kmm-update-'))return;
 await assertNoLinks(job);const input=JSON.parse(await fs.readFile(job,'utf8'));
 if(path.resolve(input.installRoot,'KiriuModsManager.exe').toLowerCase()!==path.resolve(executable).toLowerCase()||input.version!==version)return;
 await fs.writeFile(path.join(path.dirname(job),'started.json'),JSON.stringify({version,pid:process.pid}),{flag:'wx'});
 // Older installed helpers retain the previous program. Finish their successful upgrade too.
 void (async()=>{
  for(let i=0;i<120;i++){
   try {
    const result=JSON.parse(await fs.readFile(path.join(path.dirname(job),'result.json'),'utf8'));
    if(result.stage==='success'){await cleanupUpdateBackup(job,executable,version,cacheDirectory);return;}
    if(['error','rolled-back','unconfirmed'].includes(result.stage))return;
   }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
   await new Promise(resolve=>setTimeout(resolve,500));
  }
 })().catch(error=>{void logEvent('updater','update.cleanup-failed',{message:(error as Error).message},'warning');});
}
