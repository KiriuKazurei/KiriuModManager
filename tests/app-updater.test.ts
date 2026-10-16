import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {zipSync,strToU8} from 'fflate';
import {AppUpdater,assertUpdateLocation,newerVersion,resolveAppUpdate,validateAppPackage,validateUpdateManifest,cleanupUpdateBackup,startUpdateHelper} from '../src/main/app-updater';
import {validateUpdateSource} from '../src/main/web-links';
import {defaultSettings,mergeDesktopPreferences,SettingsStore} from '../src/main/settings';
import {acceptSubmittedPreferences} from '../src/renderer/settings-draft';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const source='https://updates.example.test/kmm-update.json';
function payload(version='0.0.2'){
 const files:Record<string,Uint8Array>={
  'KiriuModsManager.exe':strToU8('test executable; never run'),
  'resources/app/package.json':strToU8(JSON.stringify({name:'kiriu-mods-manager',version,main:'dist/main/index.js'})),
  'resources/app/dist/main/index.js':strToU8('main'),
  'resources/app/dist/preload/index.js':strToU8('preload'),
  'resources/app/dist/renderer/index.html':strToU8('renderer'),
  'resources/app/assets/update-helper.ps1':strToU8('test helper; never run'),
 };
 files['kmm-package.json']=strToU8(JSON.stringify({schemaVersion:1,product:'kiriu-mods-manager',platform:'win32-x64',version,files:Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,digest(bytes)]))}));return files;
}
function manifest(archive:Uint8Array,version='0.0.2'){return {schemaVersion:1,product:'kiriu-mods-manager',platform:'win32-x64',version,notes:'Changes <script>plain text</script>',publishedAt:'2026-10-13T00:00:00Z',url:'https://updates.example.test/new.zip',size:archive.length,sha256:digest(archive)};}
async function fixture(archiveOverride?:Uint8Array){
 const parent=path.resolve('.run-data/updater-tests');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-'));const root=path.join(run,'程序 旧版');
 for(const [name,bytes]of Object.entries(payload('0.0.1'))){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
 const archive=archiveOverride??zipSync(Object.fromEntries(Object.entries(payload()).map(([name,bytes])=>[`KiriuModsManager-0.0.2-win-x64/${name}`,bytes])));
 const info=manifest(archive);const urls:string[]=[];let actual:Uint8Array=archive;let protectedPaths=[path.join(run,'data')];
 const updater=new AppUpdater({currentVersion:'0.0.1',installRoot:root,packaged:true,cacheDirectory:path.join(run,'data','updates'),helperPath:path.join(root,'resources/app/assets/update-helper.ps1'),protectedPaths:async()=>protectedPaths,fetch:async url=>{urls.push(url);return url===source?new Response(JSON.stringify(info)):new Response(actual as BodyInit);}});
 return {run,root,updater,urls,info,setBytes:(bytes:Uint8Array)=>{actual=bytes;},setProtected:(paths:string[])=>{protectedPaths=paths;}};
}
test('stable numeric versions reject invalid input and never downgrade; sources require HTTPS without credentials',()=>{
 assert.equal(newerVersion('0.0.10','0.0.2'),true);assert.equal(newerVersion('0.0.1','0.0.1'),false);assert.equal(newerVersion('0.0.1','0.1.0'),false);
 for(const bad of ['v0.0.2','0.01.2','0.0.2-beta','9007199254740992.0.0'])assert.throws(()=>newerVersion(bad,'0.0.1'));
 for(const bad of ['http://example.com/update','file:///update','https://user:secret@example.com/update','https://example.com/{gameId}','https://example.com/update#fragment'])assert.throws(()=>validateUpdateSource(bad));
 const info=manifest(new Uint8Array([1]));for(const patch of [{product:'other'},{platform:'linux-x64'},{sha256:'bad'},{size:0},{size:600*1024**2},{url:'http://example.com/zip'},{version:'0.2.0-beta'},{publishedAt:'bad'}])assert.throws(()=>validateUpdateManifest({...info,...patch},source));
});
test('update source patches preserve legacy preferences, persist and keep in-flight source edits',async()=>{
 const f=await fixture();const store=new SettingsStore(path.join(f.run,'settings'));const original={...defaultSettings(),desktop:{marketUrl:'https://example.com/mods',updateUrl:'https://example.com/page',closeToTray:false}};
 const saved=await store.save(mergeDesktopPreferences(original,{updateSourceUrl:source}));assert.equal(saved.desktop?.updateUrl,original.desktop.updateUrl);assert.equal((await new SettingsStore(path.dirname(store.file)).read()).desktop?.updateSourceUrl,source);
 const baseline={...original.desktop,updateSourceUrl:''};const draft={...baseline,updateSourceUrl:source};const next=acceptSubmittedPreferences({...draft,updateSourceUrl:'https://example.com/edited'},baseline,saved.desktop!,{updateSourceUrl:source});assert.equal(next.draft.updateSourceUrl,'https://example.com/edited');
 assert.throws(()=>mergeDesktopPreferences(original,{updateSourceUrl:undefined}));
});
test('GitHub resolver pins the release version, repository, asset size and digest',async()=>{
 const info=manifest(new Uint8Array([1,2]));info.url='https://github.com/owner/repo/releases/download/v0.0.2/new.zip';
 const release={tag_name:'v0.0.2',draft:false,prerelease:false,assets:[{name:'kmm-update.json',browser_download_url:'https://github.com/owner/repo/releases/download/v0.0.2/kmm-update.json',size:100},{name:'new.zip',browser_download_url:info.url,size:info.size,digest:`sha256:${info.sha256}`}]};
 const fetch=async(url:string)=>new Response(JSON.stringify(url.includes('api.github.com')?release:info));assert.equal((await resolveAppUpdate(fetch,'https://github.com/owner/repo/releases/latest')).version,'0.0.2');
 release.tag_name='v0.0.3';await assert.rejects(resolveAppUpdate(fetch,'https://github.com/owner/repo'),/不一致/);release.tag_name='v0.0.2';release.assets[1].browser_download_url='https://github.com/other/repo/releases/download/v0.0.2/new.zip';await assert.rejects(resolveAppUpdate(fetch,'https://github.com/owner/repo'),/不一致/);
});
test('network errors, HTTPS downgrade redirects and oversized manifests are rejected',async()=>{
 await assert.rejects(resolveAppUpdate(async()=>new Response('unavailable',{status:503}),source),/503/);
 let requests=0;await assert.rejects(resolveAppUpdate(async()=>{requests++;return new Response(null,{status:302,headers:{location:'http://example.com/update'}});},source),/HTTPS/);assert.equal(requests,1);
 await assert.rejects(resolveAppUpdate(async()=>new Response('x'.repeat(256*1024+1)),source),/过大/);
});
test('download and install confirmations cancel without changing the package; source changes invalidate checked release',async()=>{
 const f=await fixture();assert.equal((await f.updater.check(source)).stage,'available');assert.equal(await f.updater.download(source,async()=>false),null);assert.equal(f.urls.length,1);
 assert.equal((await f.updater.download(source,async()=>true))?.stage,'ready');assert.equal(await f.updater.install(source,async()=>false),null);assert.equal(f.updater.status.stage,'ready');
 let called=false;const result=await f.updater.install(source,async()=>true,async job=>{called=true;const input=JSON.parse(await fs.readFile(job,'utf8'));assert.equal(input.installRoot,f.root);assert.ok(input.backup.startsWith(f.run+path.sep));});assert.equal(result?.stage,'installing');assert.equal(called,true);await validateAppPackage(f.root,'0.0.1');
 const changed=await fixture();await changed.updater.check(source);await assert.rejects(changed.updater.download('https://different.example/update',async()=>true),/已改变/);
});
test('corrupt, truncated, oversized and traversal packages fail before installation and retain current bytes',async()=>{
 for(const kind of ['corrupt','truncated','oversized','traversal']){
  const f=await fixture(kind==='traversal'?zipSync({'../outside.txt':strToU8('unsafe')}):undefined);await f.updater.check(source);
  if(kind==='corrupt')f.setBytes(new Uint8Array(f.info.size).fill(1));if(kind==='truncated')f.setBytes(new Uint8Array(1));if(kind==='oversized')f.setBytes(new Uint8Array(f.info.size+1));
  await assert.rejects(f.updater.download(source,async()=>true));assert.equal(f.updater.status.stage,'error');await validateAppPackage(f.root,'0.0.1');await assert.rejects(fs.stat(path.join(f.run,'outside.txt')));
 }
});
test('overlapping user data and current unlisted files prevent installation; modified prepared files cannot install',async()=>{
 const f=await fixture();assert.throws(()=>assertUpdateLocation(f.root,[path.join(f.root,'data')]));assert.throws(()=>assertUpdateLocation(f.root,[f.run]));assertUpdateLocation(f.root,[path.join(f.run,'Mods')]);
 await f.updater.check(source);await f.updater.download(source,async()=>true);await fs.writeFile(path.join(f.root,'personal.txt'),'preserve');let helper=false;await assert.rejects(f.updater.install(source,async()=>true,async()=>{helper=true;}),/清单外/);assert.equal(helper,false);assert.equal(await fs.readFile(path.join(f.root,'personal.txt'),'utf8'),'preserve');
 const g=await fixture();await g.updater.check(source);await g.updater.download(source,async()=>true);const transaction=(await fs.readdir(g.run)).find(name=>name.startsWith('.kmm-update-'))!;await fs.writeFile(path.join(g.run,transaction,'unpacked','KiriuModsManager-0.0.2-win-x64','KiriuModsManager.exe'),'tampered');await assert.rejects(g.updater.install(source,async()=>true),/校验失败/);await validateAppPackage(g.root,'0.0.1');
});
test('concurrent update tasks reject while status remains readable; checking a current or older version never downloads',async()=>{
 const f=await fixture();let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});await f.updater.check(source);const download=f.updater.download(source,async()=>{await hold;return false;});await assert.rejects(f.updater.check(source),/正在进行/);assert.equal((await f.updater.readStatus()).currentVersion,'0.0.1');release();await download;
 f.info.version='0.0.1';assert.equal((await f.updater.check(source)).stage,'current');await assert.rejects(f.updater.download(source,async()=>true),/已改变/);assert.equal(f.urls.filter(url=>url.endsWith('new.zip')).length,0);
});

test('current managed Mods tree is preserved and excluded only from installed package verification',async()=>{
 const f=await fixture();const mod=path.join(f.root,'Mods','ZZZ','DISABLED_Test','main.ini');await fs.mkdir(path.dirname(mod),{recursive:true});await fs.writeFile(mod,'user mod bytes');
 await validateAppPackage(f.root,'0.0.1',true);await assert.rejects(validateAppPackage(f.root,'0.0.1'),/保留/);
 await f.updater.check(source);assert.equal((await f.updater.download(source,async()=>true))?.stage,'ready');
 let started=false;await f.updater.install(source,async()=>true,async()=>{started=true;});assert.equal(started,true);assert.equal(await fs.readFile(mod,'utf8'),'user mod bytes');
 await fs.writeFile(path.join(f.root,'personal.txt'),'unlisted');await assert.rejects(validateAppPackage(f.root,'0.0.1',true),/清单外/);
});
test('incoming packages cannot ship the reserved Mods directory even with a valid file manifest',async()=>{
 const files=payload();const mod=strToU8('must not overwrite user mods');files['Mods/ZZZ/mod.ini']=mod;
 const fileManifest=JSON.parse(Buffer.from(files['kmm-package.json']).toString());fileManifest.files['Mods/ZZZ/mod.ini']=digest(mod);files['kmm-package.json']=strToU8(JSON.stringify(fileManifest));
 const archive=zipSync(Object.fromEntries(Object.entries(files).map(([name,bytes])=>[`KiriuModsManager-0.0.2-win-x64/${name}`,bytes])));const f=await fixture(archive);await f.updater.check(source);await assert.rejects(f.updater.download(source,async()=>true),/Mods/);await validateAppPackage(f.root,'0.0.1');
});

test('Windows update helper transfers Mods and restores identical bytes when rolling back', {skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),prepared=path.join(f.run,'prepared'),backup=path.join(f.run,'backup'),failed=path.join(f.run,'failed');
 for(const [name,bytes]of Object.entries(payload())){const file=path.join(prepared,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
 const files={'Mods/ZZZ/DISABLED_测试/main.ini':'zzz bytes','Mods/Endfield/角色/texture.dds':'endfield bytes','log/application-fixture.jsonl':'preserved diagnostic bytes'};
 for(const [name,bytes]of Object.entries(files)){const file=path.join(f.root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
 const driver=path.join(f.run,'helper-functions.ps1');await fs.writeFile(driver,`\uFEFFparam([string]$Helper,[string]$Old,[string]$Prepared,[string]$Backup,[string]$Failed)
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Helper,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Helper parse failed.' }
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) { . ([scriptblock]::Create($definition.Extent.Text)) }
foreach ($target in @($Old,$Prepared,$Backup,$Failed)) { Assert-Within $PSScriptRoot $target }
Assert-Package $Old '0.0.1' $true
Assert-Package $Prepared '0.0.2'
Move-WithRetry $Old $Backup
Move-WithRetry $Prepared $Old
Move-Mods $Backup $Old
Move-Mods $Backup $Old 'log'
Assert-Package $Old '0.0.2' $true
if (-not (Test-Path -LiteralPath (Join-Path $Old 'Mods/ZZZ/DISABLED_测试/main.ini'))) { throw 'Mods lost during update.' }
Move-Mods $Old $Backup
Move-Mods $Old $Backup 'log'
Move-WithRetry $Old $Failed
Move-WithRetry $Backup $Old
Assert-Package $Old '0.0.1' $true
Write-Output 'Mods transfer and rollback passed.'
`,'utf8');
 // Windows PowerShell must not inherit PowerShell Core's module directories from the test runner.
 const env={...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')};
 await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',driver,'-Helper',path.resolve('assets/update-helper.ps1'),'-Old',f.root,'-Prepared',prepared,'-Backup',backup,'-Failed',failed],{env,windowsHide:true,timeout:30000});
 for(const [name,bytes]of Object.entries(files))assert.equal(await fs.readFile(path.join(f.root,name),'utf8'),bytes);
 await assert.rejects(fs.stat(path.join(failed,'Mods')),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(failed,'log')),{code:'ENOENT'});await validateAppPackage(f.root,'0.0.1',true);await validateAppPackage(failed,'0.0.2');
});

async function completedUpdate(){
 const f=await fixture();await f.updater.check(source);await f.updater.download(source,async()=>true);
 let job='';await f.updater.install(source,async()=>true,async file=>{job=file;});
 const input=JSON.parse(await fs.readFile(job,'utf8'));
 await fs.rename(input.installRoot,input.backup);await fs.rename(input.prepared,input.installRoot);
 const result={stage:'success',version:input.version,installRoot:input.installRoot,backup:input.backup,message:'started'};
 await fs.writeFile(path.join(path.dirname(job),'result.json'),JSON.stringify(result));
 await fs.writeFile(input.resultFile,JSON.stringify(result));
 return {...f,job,input,cache:path.dirname(input.resultFile),executable:path.join(input.installRoot,'KiriuModsManager.exe')};
}
test('successful updates from older helpers remove only the verified previous program and clear the backup reference',async()=>{
 const f=await completedUpdate();await fs.mkdir(path.join(f.root,'Mods'),{recursive:true});await fs.writeFile(path.join(f.root,'Mods','keep.ini'),'user bytes');
 assert.equal(await cleanupUpdateBackup(f.job,f.executable,'0.0.2',f.cache),true);
 await assert.rejects(fs.stat(f.input.backup),{code:'ENOENT'});
 assert.equal(await fs.readFile(path.join(f.root,'Mods','keep.ini'),'utf8'),'user bytes');
 assert.equal(JSON.parse(await fs.readFile(f.input.resultFile,'utf8')).backup,undefined);
 await validateAppPackage(f.root,'0.0.2',true);
 assert.equal(await cleanupUpdateBackup(f.job,f.executable,'0.0.2',f.cache),true);
});
test('failed or unconfirmed updates and leftover user files never trigger previous-package cleanup',async()=>{
 const f=await completedUpdate(),resultFile=path.join(path.dirname(f.job),'result.json');
 for(const stage of ['waiting','error','rolled-back','unconfirmed']){
  await fs.writeFile(resultFile,JSON.stringify({stage,version:'0.0.2',installRoot:f.root}));
  assert.equal(await cleanupUpdateBackup(f.job,f.executable,'0.0.2',f.cache),false);await validateAppPackage(f.input.backup,'0.0.1');
 }
 await fs.writeFile(resultFile,JSON.stringify({stage:'success',version:'0.0.2',installRoot:f.root}));
 await fs.mkdir(path.join(f.input.backup,'Mods'));await fs.writeFile(path.join(f.input.backup,'Mods','keep.ini'),'retain');
 await assert.rejects(cleanupUpdateBackup(f.job,f.executable,'0.0.2',f.cache),/保留/);
 assert.equal(await fs.readFile(path.join(f.input.backup,'Mods','keep.ini'),'utf8'),'retain');
});
test('cleanup refuses a changed backup boundary, installed identity or result destination',async()=>{
 const f=await completedUpdate();
 for(const patch of [{backup:f.root},{installRoot:f.run},{resultFile:path.join(f.run,'unrelated.json')}]){
  await fs.writeFile(f.job,JSON.stringify({...f.input,...patch}));
  await assert.rejects(cleanupUpdateBackup(f.job,f.executable,'0.0.2',f.cache),/清理范围/);
  await validateAppPackage(f.input.backup,'0.0.1');
 }
});
test('Windows helper deletes its verified temporary previous package after acknowledgement', {skip:process.platform!=='win32'},async()=>{
 const f=await completedUpdate(),driver=path.join(f.run,'cleanup-helper.ps1');
 await fs.writeFile(driver,`param([string]$Helper,[string]$Backup,[string]$Install)
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Helper,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Helper parse failed.' }
foreach ($definition in $ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst]},$false)) { . ([scriptblock]::Create($definition.Extent.Text)) }
Remove-PreviousPackage $Backup '0.0.1' $Install
if (Test-Path -LiteralPath $Backup) { throw 'Previous program remained.' }
`,'utf8');
 const env={...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')};
 await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',driver,'-Helper',path.resolve('assets/update-helper.ps1'),'-Backup',f.input.backup,'-Install',f.root],{env,windowsHide:true,timeout:30000});
 await assert.rejects(fs.stat(f.input.backup),{code:'ENOENT'});await validateAppPackage(f.root,'0.0.2');
});
test('Windows helper startup records native output and waits for its explicit ready signal', {skip:process.platform!=='win32'},async()=>{
 const f=await fixture(),directory=path.join(f.run,'.kmm-update-start-test');await fs.mkdir(directory);
 await fs.writeFile(path.join(directory,'job.json'),'{}');
 await fs.writeFile(path.join(directory,'update-helper.ps1'),`param([string]$JobFile)
$ErrorActionPreference='Stop'
Get-FileHash -LiteralPath $JobFile -Algorithm SHA256 | Out-Null
Write-Output 'helper fixture ready'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'result.json'),'{"stage":"waiting"}')
`);
 await startUpdateHelper(path.join(directory,'job.json'));
 const output=await fs.readFile(path.join(directory,'helper-output.log'));
 assert.match(output[0]===0xff&&output[1]===0xfe?output.subarray(2).toString('utf16le'):output.toString('utf8'),/helper fixture ready/);
});
