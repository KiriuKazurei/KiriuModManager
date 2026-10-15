import {ApplicationLog} from '../../src/main/application-log';
import {OperationLog} from '../../src/main/operation-log';
import path from 'node:path';
async function main(){
 const [root,mode]=process.argv.slice(2);const logger=await ApplicationLog.open({installDirectory:path.join(root,'install'),dataDirectory:path.join(root,'data'),version:'0.0.5'});
 process.on('uncaughtExceptionMonitor',error=>logger.fatalSync('process.uncaught-exception',error));
 const operations=new OperationLog(path.join(root,'data'),logger);
 if(mode==='clean'){await logger.close();return;}
 await operations.run('mods:operate',['zzz'],async()=>{await logger.flush();if(mode==='fatal')setImmediate(()=>{throw Object.assign(new Error('Controlled fatal fixture'),{code:'FIXTURE_FATAL'});});else process.exit(17);await new Promise(()=>{});});
}
void main();
