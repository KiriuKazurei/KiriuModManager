import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const require=createRequire(import.meta.url),{ModService}=require('../dist/main/mods.js'),{SettingsStore,defaultSettings}=require('../dist/main/settings.js');
const parent=path.resolve('.run-data/performance-recovery-smoke');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-'));
const input=process.argv.find(arg=>arg.startsWith('--fixture='))?.slice(10),data=path.join(run,'data'),root=path.join(run,'Mods');
if(input){
 const source=path.resolve(input);assert.ok(source.startsWith(path.resolve('.run-data/library-performance')+path.sep));await fs.cp(path.join(source,'data'),data,{recursive:true});await fs.cp(path.join(source,'zzz','Mods'),root,{recursive:true});
 const settings=JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8'));settings.games.zzz.modsDirectory=root;await fs.writeFile(path.join(data,'settings.json'),JSON.stringify(settings));
 for(const file of ['library-zzz.json','presets-zzz.json']){const target=path.join(data,file),json=JSON.parse(await fs.readFile(target,'utf8'));json.root=root;await fs.writeFile(target,JSON.stringify(json));}
}else{
 const settings=defaultSettings();settings.games.zzz.modsDirectory=root;await new SettingsStore(data).save(settings);
 for(let index=0;index<1000;index++)await write(path.join(root,'Bench-'+String(index).padStart(5,'0'),'main.ini'),'[Constants]\nvalue=1');
}
let app,page;const outcomes=[],errors=[];
function value(result){assert.equal(result.ok,true,result.error);return result.value;}
async function request(method,...args){return page.evaluate(({method,args})=>window.kmm[method](...args),{method,args});}
async function launch(profile){const env={...process.env,KMM_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.KMM_DEV_URL;delete env.KMM_UPDATE_JOB;app=await electron.launch({args:['.'],cwd:process.cwd(),env});page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:'备份与恢复',exact:true}).waitFor();}
async function ready(){await page.waitForFunction(()=>!document.querySelector('.current-game-select')?.disabled);}
async function scroll(selector,end){await page.locator(selector).evaluate((node,end)=>{node.scrollTop=end?node.scrollHeight:0;node.dispatchEvent(new Event('scroll',{bubbles:true}));},end);}
async function write(file,text){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
try{
 await launch(data);await page.getByRole('button',{name:/^全部 Mod/}).click();await page.locator('.mod-list.virtual-list').waitFor();await ready();
 const library=value(await request('scanMods','zzz'));assert.equal(library.mods.length,1000);const first=library.mods[0],last=library.mods.at(-1);
 assert.ok(await page.locator('.mod-row').count()<30);assert.equal(await page.locator('.exclusive-members input').count(),0);
 await page.getByLabel('选择 '+first.name,{exact:true}).check();await scroll('.mod-list',true);await page.getByLabel('选择 '+last.name,{exact:true}).check();
 await page.locator('.mod-row').filter({has:page.locator('strong',{hasText:last.name})}).click();await page.getByLabel('作者',{exact:true}).fill('大库未保存草稿');
 await scroll('.mod-list',false);await page.getByLabel('选择 '+first.name,{exact:true}).waitFor();assert.equal(await page.getByLabel('选择 '+first.name,{exact:true}).isChecked(),true);
 await page.getByLabel('搜索 Mod',{exact:true}).fill(first.name);await page.locator('.list-caption').filter({hasText:'1 个结果'}).waitFor();assert.equal(await page.getByLabel('选择 '+first.name,{exact:true}).isChecked(),true);
 assert.match(await page.locator('.mod-batch-tools').textContent(),/已选 2 项，筛选内 1 项/);await page.getByRole('button',{name:'重新扫描',exact:true}).click();await ready();assert.equal(await page.getByLabel('作者',{exact:true}).inputValue(),'大库未保存草稿');
 await page.getByLabel('搜索 Mod',{exact:true}).fill('');await page.locator('.list-caption').filter({hasText:'1000 个结果'}).waitFor();
 const group=page.locator('.exclusive-groups');await group.locator('summary').first().click();await group.locator('.exclusive-member-list.virtual-list').waitFor();assert.ok(await group.locator('.exclusive-member-list input').count()<20);
 await group.locator('.exclusive-member-list .check-row').filter({hasText:first.name}).locator('input').check();await scroll('.exclusive-member-list',true);await group.locator('.exclusive-member-list .check-row').filter({hasText:last.name}).locator('input').check();
 await group.getByLabel('互斥组名称',{exact:true}).fill('虚拟成员草稿');await group.locator('summary').first().click();await group.locator('summary').first().click();assert.equal(await group.getByLabel('互斥组名称',{exact:true}).inputValue(),'虚拟成员草稿');
 assert.equal(await group.locator('.exclusive-member-list .check-row').filter({hasText:first.name}).locator('input').isChecked(),true);
 await scroll('.exclusive-member-list',true);assert.equal(await group.locator('.exclusive-member-list .check-row').filter({hasText:last.name}).locator('input').isChecked(),true);
 await page.screenshot({path:path.join(run,'large-list.png')});outcomes.push('1000 Mods: bounded rendered rows, last-row access, offscreen/filtered selection and unsaved same-ID draft survive a scan; lazy group members retain offscreen edits');
 const preset=value(await request('savePreset','zzz',null,'千项成员虚拟滚动',null)).at(-1);await page.getByRole('button',{name:'预设',exact:true}).click();await page.locator('.tool-row').filter({hasText:preset.name}).click();await page.locator('.preset-members.virtual-list').waitFor();assert.ok(await page.locator('.preset-members input').count()<30);
 const keys=Object.keys(preset.members),firstMember=library.mods.find(mod=>mod.id===keys[0]),lastMember=library.mods.find(mod=>mod.id===keys.at(-1));
 await page.locator('.preset-members .check-row').filter({hasText:firstMember.name}).locator('input').setChecked(!preset.members[firstMember.id]);await scroll('.preset-members',true);await page.locator('.preset-members .check-row').filter({hasText:lastMember.name}).locator('input').setChecked(!preset.members[lastMember.id]);
 await scroll('.preset-members',false);assert.equal(await page.locator('.preset-members .check-row').filter({hasText:firstMember.name}).locator('input').isChecked(),!preset.members[firstMember.id]);
 await page.getByRole('button',{name:'保存预设编辑',exact:true}).click();await page.getByText('预设名称与成员选项已保存。',{exact:true}).waitFor();await ready();const saved=value(await request('presets','zzz')).find(item=>item.id===preset.id);assert.equal(saved.members[firstMember.id],!preset.members[firstMember.id]);assert.equal(saved.members[lastMember.id],!preset.members[lastMember.id]);outcomes.push('1000 preset members: bounded DOM, offscreen checkbox edits persist via production save');
 await app.close();app=null;
 const recoveryParent=path.resolve('.run-data/interruption-tests');await fs.mkdir(recoveryParent,{recursive:true});const fixture=await fs.mkdtemp(path.join(recoveryParent,'run-')),profile=path.join(fixture,'data'),store=new SettingsStore(profile),configuration=defaultSettings();
 for(const game of ['zzz','endfield']){configuration.games[game].modsDirectory=path.join(fixture,game,'Mods');await write(path.join(configuration.games[game].modsDirectory,'Alpha','main.ini'),'original '+game);}await store.save(configuration);await write(path.join(fixture,'Incoming','main.ini'),'interrupted replacement');
 const mods=new ModService(profile,async game=>(await store.read()).games[game]),original=(await mods.scan('zzz')).mods[0];await mods.scan('endfield');
 const worker=fork(path.resolve('tests/helpers/interruption-worker.ts'),[fixture,'replace','new-applied','zzz'],{execArgv:['--import','tsx'],stdio:['ignore','ignore','pipe','ipc']});let stderr='';worker.stderr.on('data',bytes=>{stderr+=bytes;});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{worker.kill();reject(new Error('Worker timeout '+stderr));},15000);worker.on('message',message=>{clearTimeout(timeout);if(message.paused)resolve();else{worker.kill();reject(new Error(message.error||'Unexpected completion'));}});worker.once('error',error=>{clearTimeout(timeout);reject(error);});worker.once('exit',code=>{clearTimeout(timeout);if(code!==null)reject(new Error('Worker exited '+code+stderr));});});await new Promise(resolve=>{worker.once('exit',resolve);worker.kill('SIGKILL');});
 await launch(profile);await ready();await page.getByText(/此目录有未完成文件操作/).waitFor();await page.getByRole('button',{name:'备份与恢复',exact:true}).click();const pending=page.locator('.tool-row').filter({hasText:'中断操作：替换 Alpha'});await pending.click();
 await app.evaluate(({dialog})=>{globalThis.__restoreDialogs=[];dialog.showMessageBox=async(_window,options)=>{globalThis.__restoreDialogs.push(options);return {response:1,checkboxChecked:false};};});
 await page.getByRole('button',{name:'预览中断处理',exact:true}).click();await page.getByRole('region',{name:'恢复预览'}).waitFor();assert.equal(await fs.readFile(path.join(configuration.games.zzz.modsDirectory,'Alpha','main.ini'),'utf8'),'interrupted replacement');
 await page.getByRole('button',{name:'确认处理中断操作',exact:true}).click();await page.getByText('恢复完成，覆盖前内容已保留副本。',{exact:true}).waitFor();await ready();assert.equal(await fs.readFile(path.join(configuration.games.zzz.modsDirectory,'Alpha','main.ini'),'utf8'),'original zzz');assert.equal(value(await request('scanMods','zzz')).mods[0].id,original.id);
 const rows=value(await request('recovery','zzz')),copy=rows.find(item=>item.kind==='legacy');assert.ok(copy);assert.equal(await fs.readFile(path.join(copy.manualLocation,'main.ini'),'utf8'),'interrupted replacement');assert.ok(!rows.some(item=>item.kind==='interrupted'));const confirmation=(await app.evaluate(()=>globalThis.__restoreDialogs))[0];assert.equal(confirmation.title,'确认恢复预览');assert.equal(confirmation.message,'恢复“替换 Alpha”？');assert.match(confirmation.detail,/使用原提交服务核对身份并处理/);
 await page.locator('.tool-row').filter({hasText:'已回退，新内容副本：'}).click();await page.screenshot({path:path.join(run,'recovery.png')});outcomes.push('actual worker termination: source window blocks affected root, recovery page + production confirmation handler roll back content/identity and keep new content for manual review');
 await app.close();app=null;await launch(profile);await ready();await page.getByRole('button',{name:/^全部 Mod/}).click();await page.locator('.mod-row').waitFor();assert.equal(value(await request('scanMods','zzz')).mods[0].id,original.id);assert.equal(value(await request('scanMods','endfield')).mods[0].name,'Alpha');outcomes.push('actual App restart preserves recovered stable ID and other-game library');assert.deepEqual(errors,[]);
 await fs.writeFile(path.join(run,'report.json'),JSON.stringify({pass:true,run,recoveryFixture:fixture,outcomes,errors,scope:'real isolated Electron windows and production IPC; own worker killed; native confirmation response stubbed; no game/package/real disk exhaustion'},null,2));console.log(JSON.stringify({pass:true,run,outcomes},null,2));
}catch(error){await page?.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(run,'report.json'),JSON.stringify({pass:false,run,outcomes,errors,error:error.stack},null,2));console.error(error);process.exitCode=1;}
finally{if(app)await app.close().catch(()=>{});}
