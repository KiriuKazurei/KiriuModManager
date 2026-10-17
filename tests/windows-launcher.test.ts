import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {spawnLauncher,launcherFailure} from '../src/main/desktop';

test('native Windows launch preserves literal paths and arguments; required elevation can be declined before UAC',{skip:process.platform!=='win32'},async t=>{
 const parent=path.resolve('.run-data/windows-launcher-tests');await fs.mkdir(parent,{recursive:true});
 const run=await fs.mkdtemp(path.join(parent,"space ' & $() "));
 const compiler=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
 const ps=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 for(const elevated of [false,true]){
  const root=path.join(run,elevated?'admin':'normal');await fs.mkdir(root);const marker=path.join(root,'started.txt'),executable=path.join(root,'XXMI Launcher.exe');
  const source=path.join(root,'Program.cs');await fs.writeFile(source,`using System.IO; class Program { static void Main(string[] args) { File.WriteAllText(${JSON.stringify(marker)},string.Join("|",args)); } }`);
  const manifest=path.join(root,'app.manifest');await fs.writeFile(manifest,`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="${elevated?'requireAdministrator':'asInvoker'}" uiAccess="false"/></requestedPrivileges></security></trustInfo></assembly>`);
  await promisify(execFile)(compiler,['/nologo','/target:winexe','/out:'+executable,'/win32manifest:'+manifest,source],{windowsHide:true});
  const plan={executable,cwd:root,args:['--xxmi','ZZMI']};let confirmations=0;
  if(!elevated){await spawnLauncher(plan,async()=>{confirmations++;return false;});assert.equal(await fs.readFile(marker,'utf8'),'--xxmi|ZZMI');assert.equal(confirmations,0);}
  else {
   const {stdout}=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command','([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'],{windowsHide:true});
   if(stdout.trim()==='True'){t.diagnostic('Already elevated; OS does not require UAC, cancellation branch verified on an ordinary desktop token.');continue;}
   await assert.rejects(spawnLauncher(plan,async()=>{confirmations++;return false;}),/已取消.*管理员启动请求/);assert.equal(confirmations,1);await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  }
 }
});

test('Windows permission cancellation and runtime failure keep distinct actionable messages',()=>{
 assert.match(launcherFailure({code:1223}).message,/已取消.*Windows 权限/);
 assert.match(launcherFailure({code:740}).message,/需要管理员权限/);
 assert.match(launcherFailure({code:2,message:'file missing'}).message,/Windows 错误 2.*file missing/);
 assert.match(launcherFailure({exitCode:9}).message,/退出（9）/);
});

test('a running Launcher may log arbitrary stdout/stderr without corrupting its independent launch receipt',{skip:process.platform!=='win32'},async()=>{
 const parent=path.resolve('.run-data/windows-launcher-tests');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'output-'));
 const marker=path.join(run,'started.txt'),source=path.join(run,'Program.cs'),executable=path.join(run,'XXMI Launcher.exe');
 await fs.writeFile(source,`using System; using System.IO; using System.Diagnostics; using System.Threading; class Program { static void Main(){ File.WriteAllText(${JSON.stringify(marker)},Process.GetCurrentProcess().Id.ToString()); Console.WriteLine("Launcher log: {not a receipt}"); Console.Error.WriteLine("diagnostic output"); Thread.Sleep(5000); } }`);
 await promisify(execFile)(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/out:'+executable,source],{windowsHide:true});
 const receipt=await spawnLauncher({executable,cwd:run,args:['--nogui','--xxmi','ZZMI']});assert.equal(receipt.status,'submitted');const pid=Number(await fs.readFile(marker,'utf8'));assert.ok(pid>0);process.kill(pid,0);
});
