import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {ModService} from '../src/main/mods';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {BusinessService} from '../src/main/business';
import {CharacterCoverService} from '../src/main/character-covers';

async function main(){
const label=process.argv.find(arg=>arg.startsWith('--label='))?.slice(8)||'baseline';
const count=Number(process.argv.find(arg=>arg.startsWith('--mods='))?.slice(7)||1000);
if(!Number.isSafeInteger(count)||count<16||count>5000)throw new Error('Use 16-5000 fixture Mods');
const parent=path.resolve('.run-data/library-performance');await fs.mkdir(parent,{recursive:true});
const fixture=process.argv.find(arg=>arg.startsWith('--fixture='))?.slice(10);
const run=fixture?path.resolve(fixture):await fs.mkdtemp(path.join(parent,'run-'));
if(!run.startsWith(parent+path.sep))throw new Error('Benchmark fixture must be inside .run-data/library-performance');
const data=path.join(run,'data'),root=path.join(run,'zzz','Mods');
if(!fixture){
 const settings=defaultSettings();settings.games.zzz.modsDirectory=root;await fs.mkdir(root,{recursive:true});await new SettingsStore(data).save(settings);
 for(let index=0;index<count;index++){
  const folder=path.join(root,'角色',index%2?'安比':'艾莲',(index%2?'DISABLED_':'')+'Bench-'+String(index).padStart(5,'0'));
  await fs.mkdir(path.join(folder,'Textures'),{recursive:true});await fs.mkdir(path.join(folder,'Nested'),{recursive:true});
  await fs.writeFile(path.join(folder,'main.ini'),'[TextureOverride]\nhash='+index.toString(16).padStart(8,'0'));
  await fs.writeFile(path.join(folder,'Nested','extra.ini'),'[Constants]\nvalue=1');
  for(let texture=0;texture<4;texture++)await fs.writeFile(path.join(folder,'Textures',texture+'.dds'),Buffer.alloc(128));
 }
}
const store=new SettingsStore(data),mods=new ModService(data,async game=>(await store.read()).games[game]),business=new BusinessService(data,mods,store),covers=new CharacterCoverService(data,path.resolve('assets/character-covers'),mods);
const measurements:Record<string,unknown>={};
async function measure(name:string,work:()=>Promise<unknown>,samples=3){const times:number[]=[];for(let i=0;i<samples;i++){const start=performance.now();await work();times.push(performance.now()-start);}const sorted=[...times].sort((a,b)=>a-b);measurements[name]={samples:times.map(time=>+time.toFixed(2)),medianMs:+sorted[Math.floor(sorted.length/2)].toFixed(2)};console.log(name+': '+JSON.stringify(measurements[name]));}
console.log('Benchmark '+label+'; isolated fixture '+run);
await measure('scan',()=>mods.scan('zzz'));
await measure('characterCovers',()=>covers.read('zzz'));
const library=await mods.scan('zzz');if(library.mods.length!==count)throw new Error('Fixture count mismatch');
const members=Object.fromEntries(library.mods.slice(0,16).map(mod=>[mod.id,!mod.enabled]));
const preset=(await business.savePreset('zzz',null,'Benchmark '+label,members)).at(-1)!;
await measure('presetApply16',()=>business.applyPreset('zzz',preset.id),1);
await measure('presetApply16NoChange',()=>business.applyPreset('zzz',preset.id),1);
const saved=await store.read();
await fs.writeFile(path.join(run,label+'.json'),JSON.stringify({label,run,count,filesPerMod:6,fixture:'2 roles, 2 INI and 4 texture files per Mod',machine:{platform:process.platform,node:process.version,cpus:os.cpus().length},settings:saved.games.zzz,measurements,scope:'service completion times on this machine and isolated fixture; excludes renderer paint, website, game and packaging'},null,2));
console.log('Report: '+path.join(run,label+'.json'));
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
