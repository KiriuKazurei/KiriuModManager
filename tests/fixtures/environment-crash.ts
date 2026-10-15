import {promises as fs} from 'node:fs';
import path from 'node:path';
import {SettingsStore} from '../../src/main/settings';
import {ReadJobs} from '../../src/main/read-jobs';
import {GameEnvironmentService} from '../../src/main/environment';
async function pause(){process.send?.('committed-first-file');await new Promise(()=>{setInterval(()=>{},10000);});}
async function main(){
 const [data,next,mode]=process.argv.slice(2),store=new SettingsStore(data),jobs=new ReadJobs(async()=>''),service=new GameEnvironmentService(data,store,jobs,async phase=>{if(phase==='ini')await pause();});
 if(mode==='rollback'){
  const [record]=await service.history('zzz'),preview=await service.prepare('zzz',{kind:'rollback',repairId:record.id}),settings=await store.read(),target=path.join(settings.games.zzz.xxmiRoot,'XXMI Launcher Config.json'),rename=fs.rename;
  fs.rename=async(source,destination)=>{await rename(source,destination);if(String(destination)===target)await pause();};
  await service.apply('zzz',preview.token);return;
 }
 const report=await service.check('zzz','discover',{kind:'game',directory:next}),candidate=report.candidates.find(c=>c.paths.gameDirectory===next&&c.kind==='game')!,preview=await service.prepare('zzz',{kind:'repair',resultId:report.resultId,candidateId:candidate.id,scope:'sync-mods'});await service.apply('zzz',preview.token);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
