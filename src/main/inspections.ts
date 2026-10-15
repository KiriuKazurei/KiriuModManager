import {FileOperations} from './file-operations';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {GameId,GAMES} from '../shared/contracts';
import type {InspectionKind,ManagedReference} from '../shared/inspections';
import {SettingsStore} from './settings';
import {ModService} from './mods';
import {BusinessService} from './business';
import {Diagnostics} from './diagnostics';
import {RecoveryStorage} from './recovery-storage';
import {ConflictInspector} from './ini-context';
import {ReadJobs} from './read-jobs';
import {fileBytes,optionalDigest,sha,treeEvidence} from './inspection-files';
import {assertNoLinks,containedPath} from './archive';
export class Inspections {
 readonly jobs:ReadJobs;readonly diagnostics:Diagnostics;readonly storage:RecoveryStorage;readonly conflicts:ConflictInspector;
 constructor(private directory:string,private settings:SettingsStore,private mods:ModService,private business:BusinessService,version:string){this.jobs=new ReadJobs(game=>this.fingerprint(game));this.diagnostics=new Diagnostics(directory,mods,version);this.storage=new RecoveryStorage(directory,business.recovery,game=>this.fingerprint(game));this.conflicts=new ConflictInspector(mods);}
 async fingerprint(game:GameId){if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');const settings=await this.settings.read();const evidence:unknown[]=[settings.games[game]];for(const name of [`library-${game}.json`,`presets-${game}.json`,`recovery-preferences-${game}.json`]){try{evidence.push(await optionalDigest(path.join(this.directory,name)));}catch{evidence.push('unreadable:'+name);}}return sha(JSON.stringify(evidence));}
 async start(kind:InspectionKind,game:GameId,id?:string){if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');const paths=(await this.settings.read()).games[game];let baseline='';
  const observed=async(signal?:AbortSignal)=>{const targets=kind==='inventory'?[path.join(this.directory,'removed',game),path.join(this.directory,'profiles',game),path.join(this.directory,'import-preparations')]:[paths.modsDirectory];const evidence=[];for(const target of targets){if(!target){evidence.push('unset');continue;}try{await fs.lstat(target);evidence.push((await treeEvidence(target,{signal,hashIni:true})).fingerprint);}catch(error){signal?.throwIfAborted();evidence.push((error as NodeJS.ErrnoException).code||'unreadable');}}return sha(JSON.stringify(evidence));};
  return this.jobs.start(kind,game,paths,async(signal,progress)=>{progress('固定只读输入范围');baseline=await observed(signal);if(kind==='diagnostics')return this.diagnostics.run(game,paths,signal,progress);if(kind==='inventory')return this.storage.inventory(game,signal,progress);if(kind==='conflicts')return this.conflicts.scan(game,signal,progress);if(!id)throw new Error('请选择恢复副本。');progress('核对副本、当前文件与恢复范围');return {kind:'restore-preview',preview:await this.business.restorePlanner.prepare(game,id,signal)};},async()=>!!baseline&&baseline===await observed());
 }
 async location(game:GameId,reference:ManagedReference){if(!Object.hasOwn(GAMES,game)||!reference||typeof reference!=='object')throw new Error('位置引用无效。');let target:string;
  if(reference.kind==='mod'){target=(await this.mods.readonlyContext(game,reference.id)).directory;}
  else if(reference.kind==='recovery'){if(typeof reference.id!=='string'||!reference.id||path.basename(reference.id)!==reference.id)throw new Error('恢复引用无效。');if(/^[a-f0-9-]{36}$/.test(reference.id)){const pending=await new FileOperations(this.directory).info(game,reference.id);target=pending?path.join(this.directory,'pending-operations'):containedPath(path.join(this.directory,'removed',game),reference.id);}else{const item=(await this.business.recovery.list(game)).find(i=>i.id===reference.id&&i.kind==='legacy');if(!item)throw new Error('项目位置不可用。');target=containedPath(path.join(this.directory,'removed',game),reference.id);}}
  else if(reference.kind==='storage'&&['profiles','pending-operations','recovery-cleanup','root-history','import-preparations','environment-repairs'].includes(reference.category)){target=path.join(this.directory,reference.category,...(['profiles','root-history','environment-repairs'].includes(reference.category)?[game]:[]));}
  else throw new Error('位置引用无效。');await assertNoLinks(target);await fs.stat(target);return target;
 }
}
