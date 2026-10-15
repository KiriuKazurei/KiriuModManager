import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {GAMES,type GameId,type GamePaths} from '../shared/contracts';
import type {CompatibilityStatus,CompatibilityTarget,ProcessCompatibilityEvidence} from '../shared/compatibility';
import {assertNoLinks} from './archive';
import {requireGameExecutable} from './game-paths';
import {inspectXXMI} from './xxmi';
import {inspectInstalledVersions} from './installed-versions';
import {fileBytes,sha} from './inspection-files';
import {writeAtomicFile} from './atomic-json';
import {launchPlan} from './desktop';

async function digestFile(file:string,limit=512*1024**2){
 await assertNoLinks(file);const h=await fs.open(file,'r');
 try{const before=await h.stat({bigint:true});if(!before.isFile()||before.size>BigInt(limit))throw new Error('兼容证据文件超出预算');const hash=createHash('sha256'),buffer=Buffer.alloc(1024**2);let position=0;while(true){const {bytesRead}=await h.read(buffer,0,buffer.length,position);if(!bytesRead)break;position+=bytesRead;if(position>limit)throw new Error('摘要超出预算');hash.update(buffer.subarray(0,bytesRead));}const after=await h.stat({bigint:true}),current=await fs.stat(file,{bigint:true});const identity=(s:typeof before)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');if(identity(before)!==identity(after)||identity(after)!==identity(current))throw new Error('检测期间文件已变化');return hash.digest('hex');}finally{await h.close();}
}
async function digestTree(root:string){const items:Record<string,string>={},queue=[root];let bytes=0,nodes=0;while(queue.length){const file=queue.shift()!;if(++nodes>4096)throw new Error('兼容检测目录超出预算');await assertNoLinks(file);const stat=await fs.lstat(file);if(stat.isDirectory()){for(const name of (await fs.readdir(file)).sort())queue.push(path.join(file,name));}else{bytes+=stat.size;if(bytes>256*1024**2)throw new Error('兼容检测内容超出预算');items[path.relative(root,file).replaceAll('\\','/')]=await digestFile(file,256*1024**2);}}return sha(JSON.stringify(items));}
export async function probeCompatibilityTarget(game:GameId,fields:GamePaths,appRoot:string):Promise<CompatibilityTarget>{
 if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏');
 const match=await requireGameExecutable(game,fields.gameDirectory),inspection=await inspectXXMI(game,fields.xxmiRoot);
 await launchPlan(game,fields,'game'); // Same public path validation as the actual launch button.
 const gameFiles:Record<string,string>={exe:await digestFile(match.executable)};
 for(const name of ['config.ini','manifest.json','version.json','verify_files.json']){try{gameFiles[name]=await digestFile(path.join(fields.gameDirectory,name),16*1024**2);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;gameFiles[name]='missing';}}
 const versions=await inspectInstalledVersions(game,inspection.xxmiRoot),components:Record<string,string>={};
 for(const [name,v] of Object.entries(versions)){if(v.state!=='known'||!v.version||!v.digest)throw new Error('组件版本证据不完整');components[name]=v.version;components[name+'Manifest']=v.digest;}
 components.launcherExe=await digestFile(inspection.launcherPath);components.ini=await digestFile(inspection.iniPath,4*1024**2);
 components.core=await digestTree(path.join(inspection.importerDirectory,'Core'));
 for(const name of ['d3d11.dll','dxgi.dll','d3dx_user.ini']){try{components[name]=await digestFile(path.join(inspection.importerDirectory,name));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;components[name]='missing';}}
 // Compiled bytes are identical for SDK and product; same semver with changed code is stale.
 const managerBuild=await digestTree(path.join(appRoot,'dist','main')),gameBuild=sha(JSON.stringify(gameFiles));
 return {gameBuild,components,managerBuild,fingerprint:sha(JSON.stringify([game,gameBuild,components,managerBuild,process.platform,process.arch]))};
}
export function sealCompatibilityEvidence(value:Omit<ProcessCompatibilityEvidence,'digest'>):ProcessCompatibilityEvidence{return {...value,digest:sha(JSON.stringify(value))};}
export function validateCompatibilityEvidence(input:unknown):ProcessCompatibilityEvidence{
 if(!input||typeof input!=='object')throw new Error('兼容记录格式无效');const v=input as ProcessCompatibilityEvidence;
 const status=(s:unknown)=>['passed','failed','inconclusive'].includes(String(s)),hex=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
 if(v.schemaVersion!==1||v.kind!=='kmm-process-compatibility'||v.scope!=='restart-recovery'||!['zzz','endfield'].includes(v.gameId)||typeof v.managerVersion!=='string'||v.managerVersion.length>100||!hex(v.sourceDigest)||typeof v.runId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(v.runId)||!Number.isFinite(Date.parse(v.testedAt))||Date.parse(v.testedAt)>Date.now()+300000||!v.target||!hex(v.target.fingerprint)||!hex(v.target.gameBuild)||!hex(v.target.managerBuild)||!v.target.components||Object.values(v.target.components).some(x=>typeof x!=='string'||x.length>200)||Object.keys(v.target.components).length>30||!v.checks||!Object.values(v.checks).every(status)||Object.keys(v.checks).sort().join(',')!=='local,recovery,restart'||typeof v.recoveryComplete!=='boolean'||!status(v.verdict)||!hex(v.digest))throw new Error('兼容记录字段无效');
 if(!v.managerVersion.trim()||typeof v.testedAt!=='string'||typeof v.target.components!=='object'||Array.isArray(v.target.components)||!Object.keys(v.target.components).length||Object.keys(v.target.components).some(k=>!/^[a-zA-Z0-9._-]{1,60}$/.test(k)))throw new Error('兼容记录字段无效');
 const expected=!v.recoveryComplete||Object.values(v.checks).includes('inconclusive')?'inconclusive':Object.values(v.checks).includes('failed')?'failed':'passed';
 const {digest,...body}=v;if(v.verdict!==expected||sha(JSON.stringify(body))!==digest)throw new Error('兼容记录结论或摘要不符');return v;
}
export class CompatibilityService {
 constructor(private dataRoot:string,private appRoot:string,private managerVersion:string,private paths:(game:GameId)=>Promise<GamePaths>){}
 private file(game:GameId){if(!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏');return path.join(this.dataRoot,'compatibility',game+'.json');}
 async read(game:GameId):Promise<CompatibilityStatus>{
  const file=this.file(game);
  const result:CompatibilityStatus={gameId:game,state:'unverified',message:'尚无本地进程兼容测试记录。',checkedAt:new Date().toISOString()};
  try{result.evidence=validateCompatibilityEvidence(JSON.parse((await fileBytes(file)).toString('utf8')));if(result.evidence.gameId!==game)throw new Error('记录所属游戏不符');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){result.state='unknown';result.message='已保存的兼容记录不可验证，请重新导入。';return result;}}
  try{const before=await this.paths(game);result.target=await probeCompatibilityTarget(game,before,this.appRoot);if(JSON.stringify(before)!==JSON.stringify(await this.paths(game)))throw new Error('设置已变化');}catch{result.state='unknown';result.message='当前游戏或 XXMI 证据不完整，无法判断记录是否适用。';return result;}
  const e=result.evidence;if(!e)return result;
  if(e.managerVersion!==this.managerVersion||e.target.fingerprint!==result.target.fingerprint){result.state='stale';result.message='游戏、XXMI 或管理器已变化，此记录不再适用于当前环境。';}
  else{result.state=e.verdict;result.message=e.verdict==='passed'?'当前环境的进程重启与恢复测试通过。':e.verdict==='failed'?'当前环境的进程测试存在失败，请查看测试记录。':'当前记录证据不足，尚不能确认进程兼容性。';}return result;
 }
 async import(game:GameId,file:string){const evidence=validateCompatibilityEvidence(JSON.parse((await fileBytes(file)).toString('utf8')));if(evidence.gameId!==game)throw new Error('记录所属游戏与当前选择不符');await writeAtomicFile(this.file(game),JSON.stringify(evidence,null,2)+'\n');return this.read(game);}
}
