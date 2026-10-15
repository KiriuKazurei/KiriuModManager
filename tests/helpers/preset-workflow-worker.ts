import {promises as fs} from 'node:fs';
import path from 'node:path';
import {SettingsStore} from '../../src/main/settings';
import {ModService} from '../../src/main/mods';
import {BusinessService} from '../../src/main/business';
import {PresetManifests} from '../../src/main/preset-manifests';
async function main(){
 const [run,game,id,mode,point]=process.argv.slice(2);if(!path.resolve(run).startsWith(path.resolve('.run-data/preset-workflow-tests')+path.sep)||!['zzz','endfield'].includes(game))throw new Error('Owned fixture required');
 const gameId=game as 'zzz'|'endfield',data=path.join(run,'data'),store=new SettingsStore(data),mods=new ModService(data,async game=>(await store.read()).games[game]),business=new BusinessService(data,mods,store),manifests=new PresetManifests(data,mods,business,store),rename=fs.rename;let paused=false;process.on('message',()=>{});
 fs.rename=async(from,to)=>{await rename(from,to);let match=mode==='apply'&&point==='move'&&String(from).endsWith(path.sep+'DISABLED_Provider')&&String(to).endsWith(path.sep+'Provider');if(mode==='import'){if(point==='prepared'&&String(to).endsWith('.json')&&String(to).includes('pending-operations')){const op=JSON.parse(await fs.readFile(to,'utf8'));match=op.purpose==='preset-import'&&op.phase==='applying';}else if(point==='profile')match=String(from).endsWith(path.sep+'incoming')&&String(to).includes(path.join(data,'profiles',gameId));else if(point==='metadata')match=String(to)===path.join(data,'presets-'+gameId+'.json');}if(match&&!paused){paused=true;process.send?.({paused:true});await new Promise(()=>{});}};
 if(mode==='apply'){const plan=await business.presetPlanner.prepare(gameId,id);await business.presetPlanner.commit(gameId,plan.token);}else{const plan=await manifests.prepareImport(gameId,path.join(run,'share.kmm-profile.zip'),undefined,new AbortController().signal,()=>{});await manifests.commit(gameId,plan.token,{name:'Imported child',allowMissing:false,includeProfile:true});}process.send?.({unexpectedCompletion:true});process.exit(2);
}
void main().catch(error=>{process.send?.({error:error.message});process.exit(1);});
