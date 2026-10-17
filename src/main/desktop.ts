import {requireGameExecutable,requireMatchingGameExecutable} from './game-paths';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GameId, GAMES, GamePaths } from '../shared/contracts';
import { inspectXXMI } from './xxmi';
import { assertNoLinks } from './archive';
import { decodeIni } from './ini';
import os from 'node:os';
export interface LaunchPlan { executable:string;args:string[];cwd:string;installImporter?:string }
export async function gameExecutables(game:GameId,directory:string){return [(await requireGameExecutable(game,directory)).executable];}
export async function launchPlan(game:GameId,fields:GamePaths,mode:'gui'|'game'):Promise<LaunchPlan>{
 if(!['gui','game'].includes(mode))throw new Error('启动方式无效。');
 const installation=await inspectXXMI(game,fields.xxmiRoot);
 if(!installation.launcherExists)throw new Error('未找到完整的 XXMI Launcher，请检查安装位置。');
 await assertNoLinks(installation.launcherPath);
 const installImporter=installation.importerExists?undefined:GAMES[game].importer;
 if(mode==='game'&&!installImporter)await requireMatchingGameExecutable(game,fields.gameDirectory,installation.gameDirectory);
 return {executable:installation.launcherPath,args:mode==='game'&&!installImporter?['--nogui','--xxmi',GAMES[game].importer]:['--xxmi',GAMES[game].importer],cwd:path.dirname(installation.launcherPath),...(installImporter?{installImporter}:{})};
}
export function windowsLauncherCommand(plan:LaunchPlan,elevated:boolean,resultFile:string):string {
 const importer=plan.args.at(-1);
 if(!['ZZMI','EFMI'].includes(importer??'')||![JSON.stringify(['--xxmi',importer]),JSON.stringify(['--nogui','--xxmi',importer])].includes(JSON.stringify(plan.args)))throw new Error('无法启动 XXMI：启动参数无效。');
 // Paths travel as data; only the two fixed importer commands may become an argument string.
 const payload=Buffer.from(JSON.stringify({plan,resultFile}),'utf8').toString('base64');
 const script=`$ErrorActionPreference='Stop'
try {
 $inputData=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
 $plan=$inputData.plan
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName=[string]$plan.executable
 $info.WorkingDirectory=[string]$plan.cwd
 $info.Arguments=[string]::Join(' ',[string[]]$plan.args)
 $info.UseShellExecute=$${elevated?'true':'false'}
 ${elevated?"$info.Verb='runas'":''}
 $info.WindowStyle=[Diagnostics.ProcessWindowStyle]::Normal
 $child=[Diagnostics.Process]::Start($info)
 if($child -and $child.WaitForExit(250) -and $child.ExitCode -ne 0){$result=@{ok=$false;exitCode=$child.ExitCode}}
 else {$result=@{ok=$true}}
} catch {
 $failure=$_.Exception
 while($failure.InnerException){$failure=$failure.InnerException}
 $result=@{ok=$false;code=$failure.NativeErrorCode;message=$failure.Message}
}
$bytes=[Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Compress))
[IO.File]::WriteAllBytes($inputData.resultFile+'.tmp',$bytes)
[IO.File]::Move($inputData.resultFile+'.tmp',$inputData.resultFile)`;
 return Buffer.from(script,'utf16le').toString('base64');
}
export function launcherFailure(result:{code?:number;exitCode?:number;message?:string}):Error {
 if(result.code===1223)return new Error('已取消 XXMI 的 Windows 权限确认；需要启动时请再次点击并在系统提示中确认。');
 if(result.code===740)return new Error('XXMI 需要管理员权限，Windows 未完成权限确认，请重新启动并确认系统提示。');
 if(result.exitCode!==undefined)return new Error(`XXMI 启动后退出（${result.exitCode}），请检查运行库或 Launcher 日志。`);
 return new Error(`无法启动 XXMI${result.code?`（Windows 错误 ${result.code}）`:''}：${result.message||'请检查文件、运行库与权限。'}`);
}
export type LauncherReceipt={status:'submitted'|'unconfirmed'};
export async function spawnLauncher(plan:LaunchPlan,confirmElevation?:()=>Promise<boolean>):Promise<LauncherReceipt>{
 if(process.platform==='win32'){
  const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const start=async(elevated=false)=>{
   const directory=await fs.mkdtemp(path.join(os.tmpdir(),'kmm-launch-')),resultFile=path.join(directory,'result.json');
   try{
    const command=windowsLauncherCommand(plan,elevated,resultFile);
    await new Promise<void>((resolve,reject)=>{
     // The Launcher must inherit NUL handles, never the receipt transport or a pipe owned by Electron.
     const helper=spawn(powershell,['-NoProfile','-NonInteractive','-EncodedCommand',command],{windowsHide:true,stdio:'ignore'});
     const timer=setTimeout(()=>{helper.kill();resolve();},120000);
     helper.once('error',error=>{clearTimeout(timer);reject(new Error(`无法提交 Windows 启动请求：${error.message}`));});
     helper.once('exit',()=>{clearTimeout(timer);resolve();});
    });
    try{const result=JSON.parse(await fs.readFile(resultFile,'utf8'));if(result&&typeof result.ok==='boolean')return result as{ok:boolean;code?:number;exitCode?:number;message?:string};}catch{/* A lost receipt cannot prove that a successfully launched game failed. */}
    return null;
   }finally{
    // Remove only the two private receipt files; cleanup must not turn a successful launch into an error.
    await Promise.allSettled([fs.rm(resultFile,{force:true}),fs.rm(resultFile+'.tmp',{force:true})]);
    await fs.rmdir(directory).catch(()=>{});
   }
  };
  let result=await start();
  if(result?.ok!==true&&result?.code===740&&confirmElevation){
   if(!await confirmElevation())throw new Error('已取消 XXMI 的管理员启动请求；需要启动时请再次点击并确认授权。');
   result=await start(true);
  }
  if(!result)return {status:'unconfirmed'};
  if(result.ok!==true)throw launcherFailure(result);
  return {status:'submitted'};
 }
 return new Promise((resolve,reject)=>{const child=spawn(plan.executable,plan.args,{cwd:plan.cwd,detached:true,stdio:'ignore'});let settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;if(error)reject(error);else{child.unref();resolve({status:'submitted'});}};child.once('error',()=>finish(new Error('无法启动 XXMI，请检查文件、运行库与权限。')));child.once('exit',code=>{if(code&&code!==0)finish(launcherFailure({exitCode:code}));});child.once('spawn',()=>setTimeout(()=>finish(),250));});
}
export async function refreshKey(iniPath:string){const text=decodeIni(await fs.readFile(iniPath)).text;let section='';const values:string[]=[];for(const line of text.split(/\r\n|\n|\r/)){const heading=/^\s*\[([^\]]+)\]/.exec(line);if(heading)section=heading[1].toLowerCase();if(section==='hunting'){const match=/^\s*(?:reload_config|config_reload)\s*=\s*([^;]*)(?:;.*)?$/i.exec(line);if(match)values.push(match[1].trim());}}if(values.length>1)throw new Error('存在多个刷新键配置，请在游戏内手动使用已配置的刷新键。');const key=values.length?values[0]:'F10';const match=/^(?:no_modifiers\s+)?(?:VK_)?F([1-9]|1[0-2])$/i.exec(key);if(!match)throw new Error(`刷新键“${key}”当前不支持自动发送，请在游戏内手动刷新。仅支持单独 F1–F12。`);return {name:`F${match[1]}`,virtualKey:111+Number(match[1]),defaultKey:values.length===0};}
export async function sendRefresh(helper:string,executables:string[],virtualKey:number):Promise<{pid:number;key:number}>{if(process.platform!=='win32')throw new Error('刷新请求仅支持 Windows。');const encoded=Buffer.from(JSON.stringify(executables),'utf8').toString('base64');const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');try{const {stdout}=await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-ExePathsBase64',encoded,'-VirtualKey',String(virtualKey)],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});const response=JSON.parse(stdout.trim());if(!response.ok)throw new Error(response.error||'刷新请求失败。');return response;}catch(error){if((error as {stdout?:string}).stdout){try{const response=JSON.parse((error as {stdout:string}).stdout.trim());throw new Error(response.error);}catch(parsed){if((parsed as Error).name!=='SyntaxError')throw parsed;}}throw new Error((error as Error).message.includes('刷新')?(error as Error).message:'刷新请求失败：目标不存在、前台切换被系统阻止或权限不足。');}}

