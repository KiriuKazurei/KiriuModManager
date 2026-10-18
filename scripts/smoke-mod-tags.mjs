import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const parent=path.resolve('.run-data/mod-tags-smoke');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-')),data=path.join(run,'data'),root=path.join(run,'Mods');
await fs.mkdir(data,{recursive:true});
const name='A_标签测试',folder=path.join(root,'DISABLED_'+name),tags=['夏装','高分辨率材质','动作与特效增强','自定义服装','长标签用于验证溢出展开','收藏候选'];
for(let i=0;i<200;i++){const directory=i===0?folder:path.join(root,(i===1?'':'DISABLED_')+'Sample_'+String(i).padStart(3,'0'));await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'main.ini'),'[Constants]\nvalue=1');}
await fs.writeFile(path.join(folder,'tags.json'),JSON.stringify({version:1,tags:tags.map((name,index)=>({name,color:['#147744','#174a99','#a63030','#7253a8','#d9b032','#194b5a'][index]}))}));
const other=path.join(run,'OtherMods');await fs.mkdir(other);await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({version:1,selectedGame:'zzz',games:{zzz:{modsDirectory:root,xxmiRoot:'',gameDirectory:''},endfield:{modsDirectory:other,xxmiRoot:'',gameDirectory:''}}}));
const env={...process.env,KMM_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;delete env.KMM_DEV_URL;delete env.KMM_UPDATE_JOB;
let app,page;const errors=[],checks=[];
async function launch(){app=await electron.launch({args:['.'],env,cwd:process.cwd()});page=await app.firstWindow();page.setDefaultTimeout(8000);await page.emulateMedia({reducedMotion:'reduce'});page.on('pageerror',error=>errors.push(error.message));await page.locator('.character-grid').waitFor();await page.getByRole('button',{name:/^全部 Mod/}).click();await page.getByRole('button',{name,exact:true}).click();}
async function color(input,value){await input.evaluate((node,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));},value);}
async function ready(){await page.waitForFunction(()=>!document.querySelector('.current-game-select').disabled);}
async function resize(width,height=900){await app.evaluate(({app},size)=>{const req=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json'),window=req(app.getAppPath()+'/dist/main/index.js').desktopRuntime().window;window.setMinimumSize(800,550);window.setContentSize(...size);},[width,height]);await page.waitForFunction(([w,h])=>innerWidth===w&&innerHeight===h,[width,height]);}
const row=()=>page.locator('.mod-row-selection').filter({has:page.getByRole('button',{name,exact:true})});
async function file(){return JSON.parse(await fs.readFile(path.join(folder,'tags.json'),'utf8'));}
try{
 await launch();await resize(1180);
 assert.equal(await page.locator('.mod-list-panel>.sort-control').count(),0);
 assert.ok(await page.locator('.mod-row').count()<40,'virtualization must remain bounded');
 assert.equal(await row().locator('.mod-state').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(172, 48, 48)');
 assert.equal(await page.locator('.mod-row-selection').filter({has:page.getByRole('button',{name:'Sample_001',exact:true})}).locator('.mod-state').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(24, 119, 71)');
 const overflow=row().getByRole('button',{name:`展开${name}的全部标签`,exact:true});await overflow.click();
 const all=page.getByRole('dialog',{name:`${name}的全部标签`,exact:true});await all.waitFor();assert.equal(await all.locator('.mod-tag').count(),tags.length);await page.keyboard.press('Escape');
 checks.push('virtualized row: red/green solid states, horizontal colored tags, overflow discloses all tags');
 await page.getByLabel('添加标签',{exact:true}).fill('手动标签');await color(page.getByLabel('新标签背景色',{exact:true}),'#e4b329');await page.getByRole('button',{name:'添加',exact:true}).click();
 await page.getByRole('button',{name:'编辑标签 手动标签',exact:true}).waitFor();await ready();assert.deepEqual((await file()).tags.at(-1),{name:'手动标签',color:'#e4b329'});
 await page.getByLabel('添加标签',{exact:true}).fill('夏装');await page.getByRole('button',{name:'添加',exact:true}).click();const duplicate=page.getByRole('alertdialog');await duplicate.waitFor();assert.match(await duplicate.innerText(),/已有同名标签/);await duplicate.getByRole('button',{name:'确定',exact:true}).click();assert.equal((await file()).tags.length,tags.length+1);
 await page.getByRole('button',{name:'编辑标签 手动标签',exact:true}).click({button:'right'});
 let editor=page.getByRole('dialog',{name:'编辑标签 手动标签',exact:true});await editor.waitFor();await editor.getByLabel('标签名称',{exact:true}).fill('已重命名');await color(editor.getByLabel('标签背景色',{exact:true}),'#7733cc');await editor.getByRole('button',{name:'保存标签',exact:true}).click();
 await page.getByRole('button',{name:'编辑标签 已重命名',exact:true}).waitFor();await ready();assert.deepEqual((await file()).tags.at(-1),{name:'已重命名',color:'#7733cc'});
 await page.getByRole('button',{name:'编辑标签 已重命名',exact:true}).focus();await page.keyboard.press('Shift+F10');editor=page.getByRole('dialog',{name:'编辑标签 已重命名',exact:true});await editor.waitFor();await page.keyboard.press('Escape');await editor.waitFor({state:'hidden'});
 checks.push('manual add/color and right-click rename/recolor write tags.json; keyboard context action and Escape work');
 await page.getByRole('button',{name:'筛选与排序',exact:true}).click();const filters=page.getByRole('dialog',{name:'筛选与排序',exact:true});await filters.waitFor();await filters.locator('.sort-control>summary').click();await filters.getByLabel('排序方向 1',{exact:true}).selectOption('desc');
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('kmm:display:zzz')).sort[0].direction),'desc');
 await filters.getByRole('checkbox',{name:'已重命名',exact:true}).check();await page.waitForFunction(()=>document.querySelector('.mod-list [role=listitem]')?.getAttribute('aria-setsize')==='1');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'筛选与排序',exact:true}).click();await filters.getByRole('button',{name:'清除筛选',exact:true}).click();await filters.getByRole('button',{name:'恢复名称升序',exact:true}).click();await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.querySelector('.mod-list [role=listitem]')?.getAttribute('aria-setsize')==='200');checks.push('sorting and tag/status filters are inside filter popover; sort preferences persist');
 await page.locator('.mod-list').evaluate(node=>node.scrollTop=0);await page.getByRole('button',{name,exact:true}).click();
 for(const width of [900,1180,1600]){await resize(width);await page.locator('.mod-list').evaluate(node=>node.scrollTop=0);const bounds=await row().evaluate(node=>{const list=node.closest('.mod-list-panel'),detail=document.querySelector('.mod-detail').getBoundingClientRect(),box=list.getBoundingClientRect();return {horizontal:list.scrollWidth>list.clientWidth,root:document.documentElement.scrollWidth>innerWidth,detailOnRight:detail.left>=box.right-1,rowHeight:node.getBoundingClientRect().height};});assert.equal(bounds.horizontal,false,JSON.stringify({width,bounds}));assert.equal(bounds.root,false);assert.equal(bounds.detailOnRight,true);assert.ok(Math.abs(bounds.rowHeight-102)<1,JSON.stringify({width,bounds}));await page.screenshot({path:path.join(run,`tags-${width}.png`)});}
 checks.push('900/1180/1600px windows retain right detail, bounded virtual rows and no horizontal overflow');
 for(const theme of ['day','night']){if(await page.evaluate(()=>document.documentElement.dataset.theme)!==theme)await page.getByRole('button',{name:theme==='day'?'切换到日间':'切换到夜间',exact:true}).click();await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme&&!document.documentElement.classList.contains('theme-switching'),theme);await row().screenshot({path:path.join(run,'row-'+theme+'.png')});}
 await app.close();app=null;await launch();await page.getByRole('button',{name:'编辑标签 已重命名',exact:true}).waitFor();
 await page.getByRole('button',{name:'编辑标签 已重命名',exact:true}).click({button:'right'});editor=page.getByRole('dialog',{name:'编辑标签 已重命名',exact:true});await editor.getByRole('button',{name:'删除标签',exact:true}).click();await ready();await page.getByRole('button',{name:'编辑标签 已重命名',exact:true}).waitFor({state:'hidden'});assert.ok(!(await file()).tags.some(tag=>tag.name==='已重命名'));checks.push('actual restart retains colored tags; context delete removes tag from disk and UI');
 assert.deepEqual(errors,[]);const report={result:'PASS',headedElectron:true,run,checks,errors};await fs.writeFile(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.error('Failure artifacts:',run);await page?.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});await fs.writeFile(path.join(run,'failure.txt'),String(error.stack));throw error;}
finally{await app?.close();}
