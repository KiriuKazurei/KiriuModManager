import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';

const fixture=path.resolve(process.argv.find(arg=>arg.startsWith('--fixture='))?.slice(10)||'');const parent=path.resolve('.run-data/library-performance');if(!fixture.startsWith(parent+path.sep))throw new Error('Use an isolated library-performance fixture');
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)||'window';const info=JSON.parse(await fs.readFile(path.join(fixture,'before.json'),'utf8'));const env={...process.env,KMM_DATA_DIR:path.join(fixture,'data')};delete env.ELECTRON_RUN_AS_NODE;delete env.KMM_DEV_URL;delete env.KMM_UPDATE_JOB;
let app;const measurements={},errors=[];
try{
 const start=performance.now();app=await electron.launch({args:['.'],cwd:process.cwd(),env});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));await page.getByRole('button',{name:/^全部 Mod/}).waitFor();await page.waitForFunction(()=>document.querySelector('.character-grid img')?.complete);measurements.galleryReadyMs=+(performance.now()-start).toFixed(2);
 const open=performance.now();await page.getByRole('button',{name:/^全部 Mod/}).click();await page.getByLabel('搜索 Mod',{exact:true}).waitFor();await page.waitForFunction(count=>document.querySelector('.list-caption')?.textContent.startsWith(count+' 个结果'),info.count);measurements.listCommitMs=+(performance.now()-open).toFixed(2);measurements.renderedRows=await page.locator('.mod-row').count();
 const times=[];for(const query of ['Bench-0000','Bench-0001','Bench-0002','Bench-0003','Bench-0004']){const time=performance.now();await page.getByLabel('搜索 Mod',{exact:true}).fill(query);await page.waitForFunction(()=>document.querySelector('.list-caption')?.textContent.startsWith('10 个结果'));times.push(+(performance.now()-time).toFixed(2));}
 measurements.searchCommitMs={samples:times,median:[...times].sort((a,b)=>a-b)[Math.floor(times.length/2)]};await page.getByLabel('搜索 Mod',{exact:true}).fill('');await page.waitForFunction(count=>document.querySelector('.list-caption')?.textContent.startsWith(count+' 个结果'),info.count);
 await page.screenshot({path:path.join(fixture,label+'.png')});assert.deepEqual(errors,[]);await fs.writeFile(path.join(fixture,label+'.json'),JSON.stringify({pass:true,label,fixture,count:info.count,measurements,errors,scope:'actual source window; launch-to-gallery image ready and interaction-to-matching DOM commit, not a GPU paint latency metric; same fixture and query samples'},null,2));console.log(JSON.stringify({pass:true,label,fixture,measurements}));
}catch(error){await fs.writeFile(path.join(fixture,label+'.json'),JSON.stringify({pass:false,label,measurements,errors,error:error.stack},null,2));console.error(error);process.exitCode=1;}
finally{if(app)await app.close().catch(()=>{});}
