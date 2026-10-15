import {promises as fs} from 'node:fs';
import path from 'node:path';
import {SettingsStore} from '../../src/main/settings';
import {ModService} from '../../src/main/mods';
async function main(){
 const [run,game,point]=process.argv.slice(2);if(!path.resolve(run).startsWith(path.resolve('.run-data/import-workflow-tests')+path.sep)||!['zzz','endfield'].includes(game))throw new Error('Owned fixture required');
 const store=new SettingsStore(path.join(run,'data')),mods=new ModService(path.join(run,'data'),async game=>(await store.read()).games[game]),rename=fs.rename;let paused=false;process.on('message',()=>{});
 fs.rename=async(from,to)=>{await rename(from,to);let match=point==='move'&&String(from).endsWith(path.sep+'incoming')&&String(to).endsWith(path.sep+'DISABLED_One');if(point==='metadata')match=String(to)===path.join(run,'data','library-'+game+'.json');if(point==='committed'&&String(to).includes('pending-operations')&&String(to).endsWith('.json')){const op=JSON.parse(await fs.readFile(to,'utf8'));match=op.phase==='committed';}if(match&&!paused){paused=true;process.send?.({paused:true});await new Promise(()=>{});}};
 const preview=await mods.imports.prepareLocal(game as 'zzz'|'endfield',[path.join(run,'input.zip')]);await mods.imports.commit(game as 'zzz'|'endfield',preview.token,false);process.send?.({unexpectedCompletion:true});process.exit(2);
}
void main().catch(error=>{process.send?.({error:error.message});process.exit(1);});
