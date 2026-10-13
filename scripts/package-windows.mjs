import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { path7z } from '7zip-bin-full';
import { createHash } from 'node:crypto';
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('This build packages the installed Windows x64 Electron runtime only.');
const root=path.resolve(process.cwd());
const outputArgument=process.argv.find(argument=>argument.startsWith('--output-root='));
const requestedOutput=outputArgument?.slice('--output-root='.length)||process.env.KMM_PACKAGE_OUTPUT_ROOT;
if(requestedOutput&&!path.isAbsolute(requestedOutput))throw new Error('Package output root must be an absolute path.');
const parent=requestedOutput?path.resolve(requestedOutput):path.join(root,'release');
const inside=(base,target)=>{const relative=path.relative(base,target);return !!relative&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
if(requestedOutput&&!inside(path.join(root,'.run-data'),parent))throw new Error('Custom package output must be inside this workspace .run-data directory.');
async function assertNoLinks(target){for(let current=path.resolve(target);;current=path.dirname(current)){try{if((await fs.lstat(current)).isSymbolicLink())throw new Error('Package output contains a link or junction.');}catch(error){if(error.code!=='ENOENT')throw error;}if(path.dirname(current)===current)return;}}
await assertNoLinks(parent);
const manifest=JSON.parse(await fs.readFile('package.json','utf8'));
const testVersion=process.argv.find(argument=>argument.startsWith('--test-version='))?.slice('--test-version='.length);if(testVersion){if(!requestedOutput||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(testVersion))throw new Error('Test version requires isolated .run-data output and a stable version');manifest.version=testVersion;}
const destination=path.join(parent,`KiriuModsManager-${manifest.version}-win-x64`);const relative=path.relative(parent,destination);if(relative.startsWith('..')||path.isAbsolute(relative)||!relative)throw new Error('Unsafe release output');
const archive=destination+'.zip';const reportFile=path.join(parent,'package-report.json');
const updateManifest=path.join(parent,'kmm-update.json');
for(const target of [destination,archive,reportFile,updateManifest]){if(!inside(parent,target))throw new Error('Package output escaped its root.');await assertNoLinks(target);try{await fs.lstat(target);throw new Error('Package output already exists; select a new output root: '+target);}catch(error){if(error.code!=='ENOENT')throw error;}}
// Fresh output only. Existing packages, ZIPs and reports are never replaced.
await fs.mkdir(parent,{recursive:true});await assertNoLinks(parent);await fs.mkdir(destination);await fs.cp(path.join(root,'node_modules','electron','dist'),destination,{recursive:true});
await fs.rename(path.join(destination,'electron.exe'),path.join(destination,'KiriuModsManager.exe'));
await fs.rm(path.join(destination,'resources','default_app.asar'),{force:true});
const app=path.join(destination,'resources','app');await fs.mkdir(app,{recursive:true});await fs.cp(path.join(root,'dist'),path.join(app,'dist'),{recursive:true});await fs.mkdir(path.join(app,'assets'));
for(const name of ['tray.png','app.ico','refresh-helper.ps1','update-helper.ps1'])await fs.copyFile(path.join(root,'assets',name),path.join(app,'assets',name));
const portraitDirectory=path.join(root,'assets','character-covers');const portraitManifest=JSON.parse(await fs.readFile(path.join(portraitDirectory,'manifest.json'),'utf8'));if(portraitManifest.entries.length!==88)throw new Error('Expected 88 attributed portraits');const portraitTarget=path.join(app,'assets','character-covers');await fs.mkdir(portraitTarget);await fs.copyFile(path.join(portraitDirectory,'manifest.json'),path.join(portraitTarget,'manifest.json'));for(const entry of portraitManifest.entries){if(!/^(zzz|endfield)\/[a-f0-9]{24}\.(png|jpg|jpeg|webp|gif)$/.test(entry.file)||!['zzz','endfield'].includes(entry.game)||!entry.file.startsWith(entry.game+'/'))throw new Error('Unsafe portrait asset mapping');const bytes=await fs.readFile(path.join(portraitDirectory,entry.file));if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('Portrait source hash mismatch');await fs.mkdir(path.dirname(path.join(portraitTarget,entry.file)),{recursive:true});await fs.writeFile(path.join(portraitTarget,entry.file),bytes);}
await fs.writeFile(path.join(app,'package.json'),JSON.stringify({name:manifest.name,productName:'Kiriu Mod Manager',version:manifest.version,description:manifest.description,main:manifest.main},null,2));
const modules=path.join(app,'node_modules');await fs.mkdir(modules);for(const name of ['yauzl','pend']){const source=path.join(root,'node_modules',name);const packageData=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8'));const target=path.join(modules,name);await fs.mkdir(target);for(const file of await fs.readdir(source))if(file==='package.json'||/\.js$|^LICENSE/i.test(file))await fs.copyFile(path.join(source,file),path.join(target,file));console.log(`Runtime dependency ${name} ${packageData.version}`);}
const seven=path.join(modules,'7zip-bin-full');await fs.mkdir(path.join(seven,'win','x64'),{recursive:true});for(const name of ['index.js','package.json','LICENSE.txt'])await fs.copyFile(path.join(root,'node_modules','7zip-bin-full',name),path.join(seven,name));for(const name of ['7z.exe','7z.dll'])await fs.copyFile(path.join(path.dirname(path7z),name),path.join(seven,'win','x64',name));
await fs.writeFile(path.join(destination,'使用说明.txt'),'运行 KiriuModsManager.exe，必须保留同目录全部 DLL、locales 与 resources 文件。默认配置在 Electron 用户数据目录，可用绝对 KMM_DATA_DIR 环境变量隔离。关闭主窗口默认隐藏托盘；使用托盘或设置页快捷操作退出。此便携包未签名，不包含游戏或XXMI组件，不自动启动游戏。\r\n');
const files={};async function inventory(directory){for(const item of await fs.readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())await inventory(file);else if(item.isFile())files[path.relative(destination,file).replaceAll('\\','/')]=createHash('sha256').update(await fs.readFile(file)).digest('hex');else throw new Error('Unexpected package link or special file');}}
await inventory(destination);await fs.writeFile(path.join(destination,'kmm-package.json'),JSON.stringify({schemaVersion:1,product:'kiriu-mods-manager',platform:'win32-x64',version:manifest.version,files},null,2),{flag:'wx'});
await promisify(execFile)(path7z,['a','-tzip','-mx=5',archive,path.basename(destination)],{cwd:parent,windowsHide:true,timeout:300000,maxBuffer:4*1024**2});
const bytes=await fs.readFile(archive);const sha256=createHash('sha256').update(bytes).digest('hex');
const base=process.argv.find(argument=>argument.startsWith('--update-base-url='))?.slice('--update-base-url='.length)||`https://github.com/KiriuKazurei/KiriuModManager/releases/download/v${manifest.version}/`;
const baseUrl=new URL(base);if(baseUrl.protocol!=='https:'||baseUrl.username||baseUrl.password)throw new Error('Update base URL must be HTTPS without credentials');
const notesFile=process.argv.find(argument=>argument.startsWith('--notes-file='))?.slice('--notes-file='.length)||path.join(root,'docs','release-notes',JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version+'.md');const notes=await fs.readFile(notesFile,'utf8');
await fs.writeFile(updateManifest,JSON.stringify({schemaVersion:1,product:'kiriu-mods-manager',platform:'win32-x64',version:manifest.version,publishedAt:new Date().toISOString(),notes,url:new URL(path.basename(archive),baseUrl.href.endsWith('/')?baseUrl.href:baseUrl.href+'/').href,size:bytes.length,sha256},null,2),{flag:'wx'});
const report={version:manifest.version,electron:JSON.parse(await fs.readFile('node_modules/electron/package.json','utf8')).version,platform:'win32-x64',outputRoot:parent,directory:destination,executable:path.join(destination,'KiriuModsManager.exe'),archive,updateManifest,bytes:bytes.length,sha256,contents:'Electron runtime, compiled dist, production dependencies, full 7-Zip, icons, character portraits, refresh and update helpers, package integrity manifest; no source/tests/fixtures/docs/tools/upstream',asar:false};await fs.writeFile(reportFile,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report,null,2));
