import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {AppUpdater,assertUpdateLocation,newerVersion,resolveAppUpdate,validateAppPackage,validateUpdateManifest} from '../src/main/app-updater';
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
