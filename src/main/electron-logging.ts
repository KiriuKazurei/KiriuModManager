import {app,crashReporter} from 'electron';
import {ApplicationLog} from './application-log';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {assertNoLinks} from './archive';

export async function startLocalCrashReports(logger:ApplicationLog){
 try{
  const directory=path.join(logger.directory,'crashes',logger.profileId);await assertNoLinks(directory);await fs.mkdir(directory,{recursive:true});
  const dumps:{file:string;bytes:number;time:number}[]=[];
  for(const folder of [directory,path.join(directory,'completed'),path.join(directory,'pending')])try{await assertNoLinks(folder);for(const name of await fs.readdir(folder))if(/^[a-f0-9-]{36}\.dmp$/i.test(name)){const file=path.join(folder,name);await assertNoLinks(file);const stat=await fs.stat(file);if(stat.isFile())dumps.push({file,bytes:stat.size,time:stat.mtimeMs});}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  let retained=0;for(const [index,dump]of dumps.sort((a,b)=>b.time-a.time).entries()){retained+=dump.bytes;if(index>=10||retained>128*1024**2)await fs.unlink(dump.file);}
  app.setPath('crashDumps',directory);crashReporter.start({uploadToServer:false,compress:true});
  await logger.record('runtime','crash-reporter.ready',{uploadEnabled:false,retainedDumps:Math.min(dumps.length,10)});
 }catch(error){await logger.record('runtime','crash-reporter.unavailable',{},'warning',error);}
}

// One process-wide boundary; native exceptions retain Node/Electron's fatal behavior.
export function wireElectronLogging(logger:()=>ApplicationLog|undefined){
 process.on('uncaughtExceptionMonitor',error=>logger()?.fatalSync('process.uncaught-exception',error));
 process.on('unhandledRejection',error=>{logger()?.fatalSync('process.unhandled-rejection',error);setImmediate(()=>app.exit(1));});
 process.on('warning',warning=>{void logger()?.record('runtime','process.warning',{},'warning',warning);});
 app.on('child-process-gone',(_event,details)=>{void logger()?.record('runtime','process.child-gone',{type:details.type,reason:details.reason,exitCode:details.exitCode,serviceName:details.serviceName},details.reason==='clean-exit'?'info':'error');});
 app.on('render-process-gone',(_event,contents,details)=>{void logger()?.record('runtime','process.renderer-gone',{webContentsId:contents.id,reason:details.reason,exitCode:details.exitCode},details.reason==='clean-exit'?'info':'error');});
 app.on('web-contents-created',(_event,contents)=>{
  contents.on('did-navigate',()=>{let site='local';try{site=new URL(contents.getURL()).hostname||'local';}catch{}void logger()?.record('browser','browser.document-loaded',{webContentsId:contents.id,site});});
  contents.on('preload-error',(_event,_file,error)=>{void logger()?.record('runtime','renderer.preload-error',{webContentsId:contents.id},'error',error);});
  contents.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(code!==-3)void logger()?.record('runtime','renderer.load-failed',{webContentsId:contents.id,code,isMainFrame},'error',new Error(description));});
 });
}
