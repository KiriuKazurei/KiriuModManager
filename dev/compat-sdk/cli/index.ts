import path from 'node:path';
import {parseArgs} from 'node:util';
import {stableContext} from '../adapters/context';
import {loadConfig} from '../core/config';
import {outputPath, saveJson, withRecoveryLock} from '../core/files';
import {createRunner} from '../core/runner';
import {approveBaseline, createFixTask} from '../core/tasks';
import {RecoveryJournal} from '../core/recovery';
import {watch} from '../core/watch';
import {registerLocalSuites} from '../suites/local';
import {runProcessCompatibility} from '../core/process-runner';
import {recoverProcessJournal} from '../core/processes';

async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    config: {type: 'string'}, game: {type: 'string'}, suite: {type: 'string'}, run: {type: 'string'},
    once: {type: 'boolean'}, reviewed: {type: 'boolean'}, sandbox: {type: 'string'},
    'allow-processes':{type:'boolean'},'process-journal':{type:'string'},
  }});
  const [command, subcommand] = positionals;
  if (command === 'triage') { if (!values.run) throw new Error('缺少 --run report.json'); console.log(JSON.stringify(await createFixTask(path.resolve(values.run)), null, 2)); return; }
  if (command === 'baseline' && subcommand === 'approve') { if (!values.run) throw new Error('缺少 --run report.json'); console.log(JSON.stringify(await approveBaseline(path.resolve(values.run), !!values.reviewed), null, 2)); return; }
  if (command === 'recover') {
    if(values['process-journal']){const result=await withRecoveryLock(()=>recoverProcessJournal(path.resolve(values['process-journal']!)));console.log(JSON.stringify(result));process.exitCode=result.complete?0:2;return;}
    if (!values.sandbox) throw new Error('缺少 --sandbox 本轮sandbox目录');
    const result = await withRecoveryLock(async () => (await RecoveryJournal.open(path.resolve(values.sandbox!))).restore());
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.complete ? 0 : 2; return;
  }
  if (!['inspect', 'run', 'watch'].includes(command)) throw new Error('命令：inspect / run / watch / triage / baseline approve / recover');
  const config = await loadConfig(path.resolve(values.config ?? outputPath('config.local.json')));
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('用户中断'));
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    const runner = createRunner(); registerLocalSuites(runner);
    if (command === 'watch') {if(values.suite&&values.suite!=='full'&&values.suite!=='process')throw new Error('watch --suite 只能为 full 或 process');if(values.suite==='process'&&!values['allow-processes'])throw new Error('自动进程测试需要显式 --allow-processes');if(values.game&&!['zzz','endfield'].includes(values.game))throw new Error('不支持的 --game');const result = await watch(config, runner, {signal: controller.signal, once: values.once,processMode:values.suite==='process',game:values.game as 'zzz'|'endfield'|undefined, onResult: r => console.log(JSON.stringify(r))}); process.exitCode = result.exitCode; return; }
    if (values.game !== 'zzz' && values.game !== 'endfield') throw new Error('--game 必须为 zzz 或 endfield');
    if (command === 'inspect') {
      const context = await stableContext(config, values.game, controller.signal);
      await saveJson(outputPath('inspection', values.game + '.json'), context);
      console.log(JSON.stringify(context, null, 2)); process.exitCode = context.stability === 'stable' ? 0 : 2; return;
    }
    const scope = values.suite ?? 'full';
    if(scope==='process'){const result=await runProcessCompatibility(config,values.game,!!values['allow-processes'],controller.signal);console.log(JSON.stringify(result,null,2));process.exitCode=result.exitCode;return;}
    if (scope !== 'full' && scope !== 'local') throw new Error('--suite 只能为 local、full 或 process');
    const {report, directory} = await runner.run(config, values.game, scope, {signal: controller.signal});
    const task = report.selectedVerdict === 'incompatible' ? await createFixTask(path.join(directory, 'report.json')) : undefined;
    console.log(JSON.stringify({scope, selectedVerdict: report.selectedVerdict, gameCompatibility: report.verdict, exitCode: report.exitCode, report: path.join(directory, 'report.json'), cases: report.results.map(r => ({id: r.id, statuses: r.attempts.map(a => a.status), message: r.attempts.at(-1)?.message})), task}, null, 2));
    process.exitCode = report.exitCode;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}
main().catch(error => { console.error(JSON.stringify({verdict: 'inconclusive', error: (error as Error).message})); process.exitCode = 2; });
