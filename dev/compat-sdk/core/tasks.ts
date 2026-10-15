import {promises as fs} from 'node:fs';
import path from 'node:path';
import {assertNoLinks} from '../../../src/main/archive';
import {fileBytes, isInside} from '../../../src/main/inspection-files';
import {LAYERS, type RunReport} from './types';
import {evaluateRun} from './runner';
import {OUTPUT, outputPath, readJson, saveJson, sha, withLock} from './files';

export async function readReport(file: string): Promise<RunReport> {
  if (!isInside(OUTPUT, file) || path.basename(file) !== 'report.json') throw new Error('必须指定 SDK 工作区内的 report.json');
  const report = await readJson(file) as RunReport;
  if (report.schemaVersion !== 1 || !['zzz', 'endfield'].includes(report.context?.gameId) || !/^[a-f0-9]{64}$/.test(report.context?.runKey) || !Array.isArray(report.results) || !['local', 'full'].includes(report.scope)) throw new Error('不支持的报告格式');
  const layers = report.scope === 'full' ? LAYERS : ['L0', 'L1', 'L4'] as const;
  if (evaluateRun(report.context, report.endRunKey, report.results, report.recovery, layers) !== report.selectedVerdict || evaluateRun(report.context, report.endRunKey, report.results, report.recovery, LAYERS) !== report.verdict) throw new Error('报告结论与实际用例不一致');
  return report;
}

export async function createFixTask(reportFile: string): Promise<{created: boolean; reason?: string; directory?: string}> {
  const report = await readReport(reportFile);
  if (report.selectedVerdict !== 'incompatible') return {created: false, reason: '未取得同一稳定上下文下、带有效对照和证据的重复失败断言'};
  const failures = report.results.filter(r => r.attempts.length === 2 && r.attempts.every(a => a.status === 'failed' && a.controlPassed));
  if (!failures.length) return {created: false, reason: '没有可复现失败'};
  const evidence: {path: string; digest: string}[] = [];
  const runDirectory = path.dirname(reportFile);
  for (const r of failures) for (const attempt of r.attempts) for (const file of attempt.evidence ?? []) {
    const target = path.resolve(runDirectory, file);
    if (!isInside(runDirectory, target)) throw new Error('开发任务证据必须保存在本轮目录内');
    evidence.push({path: path.relative(runDirectory, target), digest: sha(await fileBytes(target, 16 * 1024 ** 2))});
  }
  const incident = sha(JSON.stringify([report.context.runKey, failures.map(f => [f.id, f.attempts[0].attribution]).sort()]));
  return withLock('task-' + incident, async () => {
    const directory = outputPath('incidents', incident);
    try { await fs.stat(path.join(directory, 'task.json')); return {created: false, reason: '同一事件已有任务', directory}; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const command = 'npm.cmd run compat -- run --config <本机配置绝对路径> --game ' + report.context.gameId + ' --suite ' + report.scope;
    const task = {schemaVersion: 1, incident, runId: report.runId, reportFile, reportDigest: sha(await fileBytes(reportFile, 16 * 1024 ** 2)), command, context: report.context, failures, evidence, status: 'awaiting-development', publish: false};
    await saveJson(path.join(directory, 'task.json'), task, true);
    const md = `# 兼容缺陷任务\n\n游戏：${report.context.gameId}；构建：${report.context.game.buildKey}\n\n管理器提交：${report.context.source.commit}；源码摘要：${report.context.source.digest}\n\n归因：${[...new Set(failures.map(f => f.attempts[0].attribution))].join(', ')}\n\n复现：\n\n\`\`\`text\n${command}\n\`\`\`\n\n${failures.map(f => `- ${f.id}: ${f.attempts.map(a => a.message.replaceAll(/[\r\n]/g, ' ')).join(' / ')}`).join('\n')}\n\n预期：对应断言与同一环境对照通过；实际：针对失败项复测后仍失败，详见 task.json 和原报告证据。\n\n允许修改归因对应的管理器适配/业务模块、组件适配或自有测试样例。不可删除断言、降低阈值、批准新基线来掩盖失败；不改真实游戏/日常 Mod 库，不自动提交、push 或发布。修复后复跑相同构建、范围与失败断言，并确认现场恢复完整。\n`;
    await fs.writeFile(path.join(directory, 'fix-task.md'), md, {flag: 'wx'});
    return {created: true, directory};
  });
}

export async function approveBaseline(reportFile: string, reviewed: boolean) {
  if (!reviewed) throw new Error('批准基线需要显式 --reviewed，表示已人工审查本轮截图和场景');
  const report = await readReport(reportFile);
  if (report.context.stability !== 'stable' || report.recovery !== 'complete' || report.context.fixtures.sceneRevision === 'unconfigured' || report.context.fixtures.revision === 'unconfigured') throw new Error('基准 Mod/场景/稳定构建和恢复证据尚不齐全');
  for (const id of ['live.lifecycle', 'live.reference-mods', 'live.refresh-restart']) {
    const test = report.results.find(r => r.id === id);
    if (!test || test.attempts.length !== 1 || test.attempts[0].status !== 'passed') throw new Error('真实生命周期与 A/B/A/刷新重启证据尚未通过，不能批准');
  }
  const files = report.results.find(r => r.id === 'live.reference-mods')!.attempts[0].evidence ?? [];
  const captures = [];
  for (const role of ['control-before', 'enabled', 'control-after']) {
    const file = files.find(f => path.basename(f) === role + '.png');
    if (!file) throw new Error(`缺少窗口截图 ${role}.png`);
    const target = path.resolve(path.dirname(reportFile), file);
    if (!isInside(path.dirname(reportFile), target)) throw new Error('截图越出本轮目录');
    const bytes = await fileBytes(target, 16 * 1024 ** 2);
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('截图不是 PNG');
    captures.push({role, bytes, digest: sha(bytes)});
  }
  const revision = sha(JSON.stringify([report.context, captures.map(c => [c.role, c.digest])]));
  const directory = outputPath('baselines', report.context.gameId, revision);
  await assertNoLinks(directory);
  await fs.mkdir(path.dirname(directory), {recursive: true});
  await fs.mkdir(directory); // Never overwrite an existing approved baseline.
  for (const c of captures) await fs.writeFile(path.join(directory, c.role + '.png'), c.bytes, {flag: 'wx'});
  await saveJson(path.join(directory, 'baseline.json'), {schemaVersion: 1, revision, approvedAt: new Date().toISOString(), reportFile, context: report.context, captures: captures.map(({role, digest}) => ({role, digest}))}, true);
  return {directory, revision};
}
