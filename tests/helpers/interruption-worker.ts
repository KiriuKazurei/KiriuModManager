import {promises as fs} from 'node:fs';
import path from 'node:path';
import {ModService} from '../../src/main/mods';
import {SettingsStore} from '../../src/main/settings';
import {BusinessService} from '../../src/main/business';
import {OperationLog} from '../../src/main/operation-log';

async function main(){
 const [run,kind,point,game='zzz',backupId]=process.argv.slice(2);const parent=path.resolve('.run-data/interruption-tests');
 if(!path.resolve(run).startsWith(parent+path.sep)||!['zzz','endfield'].includes(game))throw new Error('Worker requires an owned interruption fixture');
 const store=new SettingsStore(path.join(run,'data')),mods=new ModService(path.join(run,'data'),async game=>(await store.read()).games[game]),business=new BusinessService(path.join(run,'data'),mods,store);
 const gameId=game as 'zzz'|'endfield',root=(await store.read()).games[gameId].modsDirectory;const mod=(await mods.scan(gameId)).mods.find(mod=>mod.name==='Alpha')!;
 const rename=fs.rename,copyFile=fs.copyFile;let paused=false;process.on('message',()=>{});
 fs.copyFile=async(from,to,flags)=>{await copyFile(from,to,flags);if(point==='staging'&&!paused&&String(to).includes('.kmm-operation-')&&String(from).endsWith('large.dds')){paused=true;process.send?.({paused:true,point});await new Promise(()=>{});}};
 fs.rename=async(from,to)=>{await rename(from,to);const output=String(to),input=String(from);
  const match=point==='old-moved'&&output.endsWith(path.sep+'original')||point==='new-applied'&&input.endsWith(path.sep+'incoming')||point==='metadata-saved'&&output===path.join(run,'data','library-'+gameId+'.json')||point==='move-applied'&&output===path.join(root,'DISABLED_Alpha');
  if(match&&!paused){paused=true;process.send?.({paused:true,point});await new Promise(()=>{});}
 };
 const action=kind==='replace'?'mods:replace':kind==='move'?'mods:operate':kind==='delete'?'mods:delete':kind==='import'?'mods:import':'recovery:restore';
 await new OperationLog(path.join(run,'data')).run(action,[gameId,kind==='snapshot'?backupId:kind==='import'?'folder':mod.id],async()=>{
 if(kind==='replace')await mods.replace(gameId,mod.id,path.join(run,'Incoming'));
 else if(kind==='move')await mods.operate(gameId,mod.id,{kind:'toggle',enabled:false});
 else if(kind==='delete')await mods.delete(gameId,mod.id);
 else if(kind==='import')await mods.import(gameId,[path.join(run,'Incoming')]);
 else if(kind==='snapshot')await business.restore(gameId,backupId);
 else throw new Error('Invalid worker operation');
 });
 process.send?.({unexpectedCompletion:true});process.exit(2);
}
void main().catch(error=>{process.send?.({error:error.message});process.exit(1);});
