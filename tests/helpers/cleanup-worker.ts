import path from 'node:path';
import {SettingsStore} from '../../src/main/settings';
import {ModService} from '../../src/main/mods';
import {BusinessService} from '../../src/main/business';
import {Inspections} from '../../src/main/inspections';
import {RecoveryStorage} from '../../src/main/recovery-storage';
import type {GameId} from '../../src/shared/contracts';
async function main(){const [run,game,id,point]=process.argv.slice(2),base=path.resolve('.run-data/second-batch-tests');if(!path.resolve(run).startsWith(base+path.sep)||!['zzz','endfield'].includes(game))throw new Error('Invalid isolated fixture');const data=path.join(run,'data'),store=new SettingsStore(data),mods=new ModService(data,async game=>(await store.read()).games[game]),business=new BusinessService(data,mods,store),inspections=new Inspections(data,store,mods,business,'0.0.4');let paused=false;const storage=new RecoveryStorage(data,business.recovery,g=>inspections.fingerprint(g),async(at,value)=>{if(at!==point||paused)return;paused=true;process.send?.({paused:true,id:value.id,at});await new Promise(()=>setInterval(()=>{},1000));});const plan=await storage.prepare(game as GameId,[id]);await storage.apply(game as GameId,plan.token);throw new Error('Unexpected completion');}void main().catch(error=>{process.send?.({error:error.stack});process.exitCode=1;});
