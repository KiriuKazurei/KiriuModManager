import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {ModService} from '../src/main/mods';
import {BusinessService} from '../src/main/business';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {normalizeTagColors,tagTextColor} from '../src/shared/mod-tags';
import {serializeModTags,readModTags} from '../src/main/mod-tags';

async function write(file:string,bytes:string){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);}
async function fixture(){
 const parent=path.resolve('.run-data/mod-tag-tests');await fs.mkdir(parent,{recursive:true});const run=await fs.mkdtemp(path.join(parent,'run-')),data=path.join(run,'data'),store=new SettingsStore(data),settings=defaultSettings();
 for(const game of ['zzz','endfield'] as const){settings.games[game].modsDirectory=path.join(run,game,'Mods');await write(path.join(settings.games[game].modsDirectory,'DISABLED_Example','main.ini'),'[Constants]\nvalue=1');}
 await store.save(settings);const service=()=>new ModService(data,async game=>(await store.read()).games[game]),mods=service(),business=new BusinessService(data,mods,store);
 return {run,data,store,settings,mods,business,service};
}

test('tag colors reject foreign keys, CSS values and invalid shapes; text contrasts with arbitrary backgrounds',()=>{
 assert.deepEqual(normalizeTagColors(['夏装'],{'夏装':'#AABBCC'}),{'夏装':'#aabbcc'});
 for(const colors of [null,[],{'别的标签':'#123456'},{'夏装':'red'},{'夏装':'#fff'},{'夏装':'url(file:///x)'}])assert.throws(()=>normalizeTagColors(['夏装'],colors));
 assert.equal(tagTextColor('#ffffff'),'#000000');assert.equal(tagTextColor('#000000'),'#ffffff');
 const names=['__proto__'];assert.equal(Object.hasOwn(normalizeTagColors(names),'__proto__'),true);
});

test('legacy tags retain names and gain default colors without a scan writing into the Mod; edits persist in tags.json and after restart',async()=>{
 const f=await fixture();let mod=(await f.mods.scan('zzz')).mods[0];const registry=path.join(f.data,'library-zzz.json'),index=JSON.parse(await fs.readFile(registry,'utf8'));index.records[mod.id].tags=['旧标签'];delete index.records[mod.id].tagColors;await fs.writeFile(registry,JSON.stringify(index));
 mod=(await f.mods.scan('zzz')).mods[0];assert.deepEqual(mod.tags,['旧标签']);assert.equal(mod.tagColors?.['旧标签'],'#4f6bed');
 const file=path.join(f.settings.games.zzz.modsDirectory,mod.relativePath,'tags.json');await assert.rejects(fs.stat(file),{code:'ENOENT'});
 const ini=await fs.readFile(path.join(path.dirname(file),'main.ini'));
 mod=(await f.mods.operate('zzz',mod.id,{kind:'tags',values:['旧标签','夏装'],colors:{'旧标签':'#ffb700','夏装':'#123456'}})).mods[0];
 assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:1,tags:[{name:'旧标签',color:'#ffb700'},{name:'夏装',color:'#123456'}]});
 assert.deepEqual((await f.service().scan('zzz')).mods[0].tagColors,mod.tagColors);assert.deepEqual(await fs.readFile(path.join(path.dirname(file),'main.ini')),ini);
 assert.deepEqual((await f.mods.scan('endfield')).mods[0].tags,[]);
});

test('a copied Mod recovers portable colored tags without the old registry; rescan reads external edits and explicit empty tags',async()=>{
 const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0];await f.mods.operate('zzz',mod.id,{kind:'tags',values:['Portable'],colors:{Portable:'#107c41'}});
 const root=path.join(f.run,'portable','Mods'),target=path.join(root,'Copy');await fs.mkdir(root,{recursive:true});await fs.cp(path.join(f.settings.games.zzz.modsDirectory,mod.relativePath),target,{recursive:true});
 const copy=new ModService(path.join(f.run,'portable-data'),async()=>({modsDirectory:root,xxmiRoot:'',gameDirectory:''}));let copied=(await copy.scan('zzz')).mods[0];assert.deepEqual(copied.tagColors,{Portable:'#107c41'});assert.notEqual(copied.id,mod.id);
 await fs.writeFile(path.join(target,'tags.json'),serializeModTags(['改名'],{'改名':'#8040e0'}));copied=(await copy.scan('zzz')).mods[0];assert.deepEqual(copied.tags,['改名']);assert.deepEqual(copied.tagColors,{'改名':'#8040e0'});
 await copy.operate('zzz',copied.id,{kind:'tags',values:[],colors:{}});assert.deepEqual((await copy.scan('zzz')).mods[0].tags,[]);assert.deepEqual(JSON.parse(await fs.readFile(path.join(target,'tags.json'),'utf8')).tags,[]);
});

test('rename, classify, replacement and content restore retain current colored tags; full snapshot restores snapshot tags',async()=>{
 const f=await fixture();let mod=(await f.mods.scan('zzz')).mods[0];const id=mod.id;
 await f.mods.operate('zzz',id,{kind:'tags',values:['Keep'],colors:{Keep:'#f0b000'}});await f.mods.operate('zzz',id,{kind:'rename',name:'Renamed'});await f.mods.operate('zzz',id,{kind:'classify',category:'角色',character:'测试角色',appearance:''});
 const source=path.join(f.run,'replacement');await write(path.join(source,'main.ini'),'replacement');await write(path.join(source,'tags.json'),serializeModTags(['Foreign'],{Foreign:'#ff0000'}));await f.mods.replace('zzz',id,source);
 const backup=(await f.business.recovery.list('zzz')).find(item=>item.kind==='mod-replace')!;mod=(await f.mods.scan('zzz')).mods[0];assert.deepEqual(mod.tags,['Keep']);assert.deepEqual(mod.tagColors,{Keep:'#f0b000'});
 await f.mods.operate('zzz',id,{kind:'tags',values:['Current'],colors:{Current:'#234567'}});await f.business.restore('zzz',backup.id);mod=(await f.mods.scan('zzz')).mods[0];assert.deepEqual(mod.tags,['Current']);assert.deepEqual(mod.tagColors,{Current:'#234567'});
 const snapshot=(await f.business.createBackup('zzz','标签快照')).find(item=>item.kind==='snapshot')!;await f.mods.operate('zzz',id,{kind:'tags',values:['Later'],colors:{Later:'#000000'}});await f.business.restore('zzz',snapshot.id);mod=(await f.mods.scan('zzz')).mods[0];assert.deepEqual(mod.tagColors,{Current:'#234567'});
});

test('invalid or oversized tags.json is rejected and never overwritten',async()=>{
 const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0],directory=path.join(f.settings.games.zzz.modsDirectory,mod.relativePath),file=path.join(directory,'tags.json');
 for(const content of ['not json',JSON.stringify({version:2,tags:[]}),JSON.stringify({version:1,tags:[{name:'a',color:'red'}]}),JSON.stringify({version:1,tags:[{name:'A',color:'#000000'},{name:'a',color:'#ffffff'}]}),'x'.repeat(32769)]){
  await fs.writeFile(file,content);await assert.rejects(f.mods.scan('zzz'));await assert.rejects(f.mods.operate('zzz',mod.id,{kind:'tags',values:['New']}));assert.equal(await fs.readFile(file,'utf8'),content);
 }
 await fs.writeFile(file,serializeModTags([],{}));await assert.rejects(f.mods.operate('zzz',mod.id,{kind:'tags',values:['New'],colors:{New:'blue'}}));assert.deepEqual((await readModTags(directory)).tags,[]);
});

test('registry publication failure rolls back both the portable sidecar and cached tag metadata',async()=>{
 const f=await fixture(),mod=(await f.mods.scan('zzz')).mods[0];await f.mods.operate('zzz',mod.id,{kind:'tags',values:['Before'],colors:{Before:'#246810'}});
 const registry=path.join(f.data,'library-zzz.json'),file=path.join(f.settings.games.zzz.modsDirectory,mod.relativePath,'tags.json'),before=await fs.readFile(file),registryBefore=await fs.readFile(registry),rename=fs.rename;let fail=true;
 fs.rename=async(from,to)=>{if(fail&&String(to)===registry){fail=false;throw Object.assign(new Error('tag publication fixture failure'),{code:'EIO'});}return rename(from,to);};
 try{await assert.rejects(f.mods.operate('zzz',mod.id,{kind:'tags',values:['After'],colors:{After:'#111111'}}),/tag publication fixture failure/);}finally{fs.rename=rename;}
 assert.deepEqual(await fs.readFile(file),before);assert.deepEqual(await fs.readFile(registry),registryBefore);assert.deepEqual((await f.mods.scan('zzz')).mods[0].tags,['Before']);
});
