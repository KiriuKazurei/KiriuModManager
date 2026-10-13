import {_electron as electron} from 'playwright';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const packaged=process.argv.includes('--packaged');const reportArgument=process.argv.find(arg=>arg.startsWith('--package-report='));
const packageReport=packaged?JSON.parse(await fs.readFile(reportArgument?.slice('--package-report='.length)||process.env.KMM_PACKAGE_REPORT||'release/package-report.json','utf8')):null;
const parent=path.resolve(process.env.KMM_SMOKE_DIR||'.run-data/modules-review/phase4-patches');assert.ok(parent.startsWith(path.resolve('.run-data')+path.sep));await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-'));const data=path.join(run,'data');
async function write(file,bytes){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
const settings={version:1,selectedGame:'endfield',games:{},desktop:{marketUrl:'',updateUrl:'',closeToTray:true}};
for(const game of ['zzz','endfield']){const modsDirectory=path.join(run,game,'Mods');settings.games[game]={xxmiRoot:path.join(run,game,'XXMI'),gameDirectory:path.join(run,game,'Game'),modsDirectory};await write(path.join(modsDirectory,'Fixture','main.ini'),'[TextureOverrideFixture]\nhash=01234567');}
await write(path.join(data,'settings.json'),JSON.stringify(settings));const env={...process.env,KMM_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;delete env.KMM_DEV_URL;let app;let main;let floating;const errors=[];
async function request(page,method,...args){return page.evaluate(({method,args})=>window.kmm[method](...args),{method,args});}
function value(result){assert.equal(result.ok,true,result.error);return result.value;}
async function launch(){app=await electron.launch({...(packaged?{executablePath:packageReport.executable,args:[],cwd:run}:{args:['.']}),env});main=await app.firstWindow();main.on('pageerror',error=>errors.push(error.message));await main.getByRole('heading',{name:/^Mod 库/}).waitFor();await main.waitForFunction(()=>!!window.kmm);}
async function subscribe(page){await page.evaluate(()=>{window.__patchEvents=[];window.__patchUnsubscribe=window.kmm.onDesktopChange(event=>window.__patchEvents.push(event));});}
async function clear(){await Promise.all([main,floating].map(page=>page.evaluate(()=>{window.__patchEvents=[];})));}
try{
  await launch();value(await request(main,'floating',true));floating=app.windows().find(page=>page!==main);assert.ok(floating);await floating.waitForFunction(()=>!!window.kmm);floating.on('pageerror',error=>errors.push(error.message));await subscribe(main);await subscribe(floating);
  const requests=[
    [main,'saveGamePaths','zzz',{xxmiRoot:path.join(run,'zzz','Updated XXMI')}],
    [floating,'saveGamePaths','endfield',{xxmiRoot:path.join(run,'endfield','Updated XXMI')}],
    [main,'saveGamePaths','zzz',{gameDirectory:path.join(run,'zzz','Updated Game')}],
    [floating,'saveGamePaths','endfield',{gameDirectory:path.join(run,'endfield','Updated Game')}],
    [main,'saveDesktopPreferences',{marketUrl:'https://example.com/mods/{gameId}'}],
    [floating,'saveDesktopPreferences',{updateUrl:'https://example.com/releases'}],
    [main,'saveDesktopPreferences',{closeToTray:false}],
  ];
  const responses=await Promise.all(requests.map(([page,method,...args])=>request(page,method,...args)));for(const response of responses){const saved=value(response);assert.equal(saved.selectedGame,'endfield');}
  const current=value(await request(main,'readSettings'));const expected=structuredClone(settings);for(const game of ['zzz','endfield'])expected.games[game]={...settings.games[game],xxmiRoot:path.join(run,game,'Updated XXMI'),gameDirectory:path.join(run,game,'Updated Game')};expected.desktop={marketUrl:'https://example.com/mods/{gameId}',updateUrl:'https://example.com/releases',closeToTray:false};assert.deepEqual(current,expected);
  for(const page of [main,floating]){await page.waitForFunction(count=>window.__patchEvents.length===count,requests.length);assert.deepEqual(await page.evaluate(()=>window.__patchEvents),requests.map(()=>({gameId:'endfield',settingsChanged:true})));}
  const concurrentEvents=await main.evaluate(()=>window.__patchEvents);
  // The old full-settings contract remains usable and still intentionally replaces all settings.
  await clear();const legacy={...current,selectedGame:'zzz',games:{...current.games,zzz:{...current.games.zzz,gameDirectory:path.join(run,'Legacy Full Save')}}};assert.deepEqual(value(await request(floating,'saveSettings',legacy)),legacy);assert.deepEqual(value(await request(main,'readSettings')),legacy);
  value(await request(main,'selectGame','endfield'));await clear();const before=await fs.readFile(path.join(data,'settings.json'));
  const invalid=[
    ['saveGamePaths','zzz',null],['saveGamePaths','zzz',[]],['saveGamePaths','zzz',{}],['saveGamePaths','zzz',{selectedGame:'zzz'}],['saveGamePaths','zzz',{modsDirectory:42}],['saveGamePaths','zzz',{modsDirectory:'relative'}],['saveGamePaths','zzz',{xxmiRoot:'bad\0path'}],['saveGamePaths','zzz',{modsDirectory:undefined}],['saveGamePaths','other',{modsDirectory:''}],['saveGamePaths','zzz',Object.fromEntries([['__proto__',{}]])],
    ['saveDesktopPreferences',null],['saveDesktopPreferences',[]],['saveDesktopPreferences',{}],['saveDesktopPreferences',{games:{}}],['saveDesktopPreferences',{closeToTray:'true'}],['saveDesktopPreferences',{marketUrl:'file:///unsafe'}],['saveDesktopPreferences',{marketUrl:'https://u:p@example.com'}],['saveDesktopPreferences',{updateUrl:null}],['saveDesktopPreferences',{updateUrl:undefined}],
  ];
  const rejected=[];for(const [index,args]of invalid.entries()){const result=await request(index%2?floating:main,...args);assert.equal(result.ok,false,JSON.stringify(args));assert.equal(typeof result.error,'string');assert.deepEqual(await fs.readFile(path.join(data,'settings.json')),before);rejected.push({method:args[0],error:result.error});}
  await main.waitForTimeout(150);for(const page of [main,floating])assert.deepEqual(await page.evaluate(()=>window.__patchEvents),[]);
  const saved=value(await request(main,'readSettings'));await main.screenshot({path:path.join(run,'main.png')});await floating.screenshot({path:path.join(run,'floating.png')});await app.close();app=null;await launch();assert.deepEqual(value(await request(main,'readSettings')),saved);assert.equal(saved.selectedGame,'endfield');assert.deepEqual(errors,[]);
  const report={result:'PASS',run,data,packaged,layoutChecked:false,productionTwoWindowBridge:true,rendererMigrated:false,concurrentCalls:requests.length,concurrentEvents,invalidPatches:rejected,legacyFullReplacement:true,restart:true,errors,noRealGameExecuted:true,checks:['two windows concurrent different-game and desktop field patches preserve all values and selection','success returns full Settings and broadcasts settingsChanged:true','invalid empty/null/array/unknown/path/URL/type patches leave saved bytes unchanged and do not broadcast','old complete saveSettings contract remains supported','latest saved patches and selection persist across actual app restart']};await write(path.join(run,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await write(path.join(run,'failure.json'),JSON.stringify({error:String(error),stack:error.stack},null,2));if(main)await main.screenshot({path:path.join(run,'failure.png')}).catch(()=>{});throw error;}finally{if(app)await app.close().catch(()=>{});}
