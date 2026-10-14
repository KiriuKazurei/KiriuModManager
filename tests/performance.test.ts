import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {ModService} from '../src/main/mods';
import {CharacterCoverService} from '../src/main/character-covers';
import {ImageCache} from '../src/main/image-cache';

async function fixture(){const base=path.resolve('.run-data/performance-tests');await fs.mkdir(base,{recursive:true});const run=await fs.mkdtemp(path.join(base,'run-')),root=path.join(run,'Mods'),data=path.join(run,'data');for(let i=0;i<32;i++){const mod=path.join(root,'Bench-'+i);await fs.mkdir(mod,{recursive:true});await fs.writeFile(path.join(mod,'main.ini'),'[Constants]\nvalue=1');}const mods=new ModService(data,async()=>({modsDirectory:root,xxmiRoot:'',gameDirectory:''}));return {run,root,data,mods};}
test('fresh scans retain external edits and no-change scans do not rewrite registry bytes',async()=>{
 const f=await fixture(),initial=await f.mods.scan('zzz'),file=path.join(f.data,'library-zzz.json'),before=await fs.stat(file);await f.mods.scan('zzz');assert.equal((await fs.stat(file)).mtimeMs,before.mtimeMs);
 await fs.writeFile(path.join(f.root,'Bench-0','extra.ini'),'extra');assert.equal((await f.mods.scan('zzz')).mods.find(mod=>mod.name==='Bench-0')?.iniCount,2);
 await fs.mkdir(path.join(f.root,'Added'));await fs.writeFile(path.join(f.root,'Added','main.ini'),'added');assert.equal((await f.mods.scan('zzz')).mods.length,33);assert.equal((await f.mods.scan('zzz')).mods.find(mod=>mod.name==='Bench-0')?.id,initial.mods.find(mod=>mod.name==='Bench-0')?.id);
});
test('preset application scans once at start/end, keeps stable IDs and rechecks collisions',async()=>{
 const f=await fixture(),library=await f.mods.scan('zzz'),read=fs.readdir;let rootReads=0;fs.readdir=async(...args:any[])=>{if(String(args[0])===f.root)rootReads++;return (read as any)(...args);};let result;
 try{result=await f.mods.applyStates('zzz',Object.fromEntries(library.mods.slice(0,16).map(mod=>[mod.id,false])));}finally{fs.readdir=read;}
 assert.ok(rootReads<=3,'one root traversal per boundary, not one per member');assert.equal(result.items.filter(item=>item.ok).length,16);assert.equal(result.library.mods.filter(mod=>!mod.enabled).length,16);assert.deepEqual(new Set(result.library.mods.map(mod=>mod.id)),new Set(library.mods.map(mod=>mod.id)));
 const target=result.library.mods.find(mod=>!mod.enabled)!;await fs.mkdir(path.join(f.root,target.name));await fs.writeFile(path.join(f.root,target.name,'main.ini'),'collision');const collided=await f.mods.applyStates('zzz',{[target.id]:true});assert.equal(collided.items[0].ok,false);assert.equal(await fs.readFile(path.join(f.root,target.name,'main.ini'),'utf8'),'collision');
});
test('cover catalog reuses the just-scanned library while image cache reflects edits/deletion and stays bounded',async()=>{
 const f=await fixture();await f.mods.scan('zzz');const covers=new CharacterCoverService(f.data,path.resolve('assets/character-covers'),f.mods),read=fs.readdir;let rootReads=0;fs.readdir=async(...args:any[])=>{if(String(args[0])===f.root)rootReads++;return (read as any)(...args);};try{assert.ok(Object.keys(await covers.read('zzz')).length>0);}finally{fs.readdir=read;}assert.equal(rootReads,0);
 const cache=new ImageCache(),file=path.join(f.run,'image.bin');await fs.writeFile(file,'first');assert.equal((await cache.read(file)).toString(),'first');await new Promise(resolve=>setTimeout(resolve,15));await fs.writeFile(file,'other');assert.equal((await cache.read(file)).toString(),'other');await fs.unlink(file);await assert.rejects(cache.read(file),{code:'ENOENT'});
 for(let i=0;i<130;i++){const image=path.join(f.run,i+'.bin');await fs.writeFile(image,Buffer.alloc(300000));await cache.read(image);}assert.ok((cache as any).size<=32*1024**2);assert.ok((cache as any).entries.size<=128);
});
test('preset disable still sets the member directory flag under an already-disabled ancestor',async()=>{
 const f=await fixture();const parent=path.join(f.root,'DISABLED_Parent');await fs.mkdir(path.join(parent,'Member'),{recursive:true});await fs.writeFile(path.join(parent,'Member','main.ini'),'member');const mod=(await f.mods.scan('zzz')).mods.find(mod=>mod.name==='Member')!;assert.equal(mod.enabled,false);assert.equal(mod.ownDisabled,false);
 const result=await f.mods.applyStates('zzz',{[mod.id]:false});assert.equal(result.items[0].ok,true);assert.equal(result.library.mods.find(item=>item.id===mod.id)?.ownDisabled,true);assert.equal(result.library.mods.find(item=>item.id===mod.id)?.relativePath,path.join('DISABLED_Parent','DISABLED_Member'));
});
