import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {stableContext} from '../adapters/context';
import type {GameId} from '../../../src/shared/contracts';
import {outputPath, saveJson, withLock} from './files';
import {pendingRecovery, RecoveryJournal} from './recovery';
import {LAYERS, type Attempt, type CaseResult, type Config, type Context, type Layer, type RunReport, type TestCase, type Verdict} from './types';

export const REQUIRED = {
  L0: ['source.gate'], L1: ['local.integration', 'local.owned-write'],
  L2: ['live.lifecycle'], L3: ['live.reference-mods', 'live.refresh-restart'], L4: ['recovery.owned'],
} as const;

function confirmedFailure(r: CaseResult) {
  const [a, b] = r.attempts;
  return !!a && !!b && a.status === 'failed' && b.status === 'failed' && a.controlPassed === true && b.controlPassed === true &&
    a.attribution === b.attribution && ['manager', 'component', 'fixture'].includes(a.attribution ?? '') && !!a.evidence?.length && !!b.evidence?.length;
}
export function evaluateRun(context: Context, endRunKey: string, results: CaseResult[], recovery: RunReport['recovery'], layers: readonly Layer[]): Verdict {
  if (context.stability !== 'stable' || context.runKey !== endRunKey || recovery !== 'complete') return 'inconclusive';
  if (layers.some(l => l === 'L2' || l === 'L3') && (!/^[a-f0-9]{64}$/.test(context.fixtures.revision) || !/^[a-f0-9]{64}$/.test(context.fixtures.sceneRevision))) return 'inconclusive';
  for (const layer of layers) for (const id of REQUIRED[layer]) {
    if (results.filter(r => r.id === id && r.layer === layer && r.required).length !== 1) return 'inconclusive';
  }
  const selected = results.filter(r => r.required && layers.includes(r.layer));
  // An unavailable control/test infrastructure takes precedence over a product defect.
  if (selected.some(r => !r.attempts.length || r.attempts.some(a => a.status === 'inconclusive' || a.status === 'skipped'))) return 'inconclusive';
  if (selected.some(confirmedFailure)) return 'incompatible';
  if (selected.every(r => r.attempts.length === 1 && r.attempts[0].status === 'passed')) return 'compatible';
  return 'inconclusive'; // Includes flaky assertions; a retry pass is not an automatic green.
}

async function execute(test: TestCase, context: Context, directory: string, parent?: AbortSignal): Promise<Attempt> {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abort, {once: true});
  if (parent?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error('用例超过时间预算')), test.timeoutMs);
  // Await the case's cleanup instead of abandoning a mutating promise on timeout.
  try {
    controller.signal.throwIfAborted();
    const result = await test.run(context, controller.signal, {directory});
    if (controller.signal.aborted) return {status: 'inconclusive', message: '用例已取消或超时', attribution: 'test'};
    return result;
  } catch (error) { return {status: 'inconclusive', message: (error as Error).message, attribution: 'test'}; }
  finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}

export function createRunner() {
  const cases = new Map<string, TestCase>();
  return {
    registerSuite(tests: TestCase[]) {
      for (const test of tests) {
        if (cases.has(test.id) || !LAYERS.includes(test.layer) || !/^[a-z0-9.-]+$/.test(test.id) || !Number.isInteger(test.timeoutMs) || test.timeoutMs < 1 || test.timeoutMs > 3600000) throw new Error('用例重复或声明无效');
        cases.set(test.id, test);
      }
    },
    async run(config: Config, game: GameId, scope: 'local' | 'full', options: {signal?: AbortSignal; probe?: typeof stableContext} = {}): Promise<{report: RunReport; directory: string}> {
      return withLock('execution', async () => {
        const probe = options.probe ?? stableContext;
        const context = await probe(config, game, options.signal);
        const runId = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
        const directory = outputPath(game, runId);
        const startedAt = new Date().toISOString();
        const pending = await pendingRecovery();
        const journal = await RecoveryJournal.create(directory);
        const layers: Layer[] = scope === 'full' ? [...LAYERS] : ['L0', 'L1', 'L4'];
        const results: CaseResult[] = [];
        let recovery: RunReport['recovery'] = 'complete', endRunKey = '';
        await saveJson(path.join(directory, 'started.json'), {runId, context, scope, pending});
        try {
          if (!pending.length && context.stability === 'stable') await journal.write('write-probe.bin', Buffer.from('compat-sdk-owned-probe'));
          for (const layer of layers.filter(l => l !== 'L4')) {
            const tests = [...cases.values()].filter(t => t.layer === layer);
            for (const id of REQUIRED[layer]) if (!tests.some(t => t.id === id)) tests.push({id, layer, required: true, timeoutMs: 1000, run: async () => ({status: 'inconclusive', message: '该必需用例尚未配置/实现', attribution: 'test'})});
            for (const test of tests) {
              const attempts: Attempt[] = [];
              if (pending.length || context.stability !== 'stable') attempts.push({status: 'inconclusive', message: pending.length ? '存在未恢复现场，禁止后续测试: ' + pending.join(', ') : '构建尚未稳定', attribution: 'environment'});
              else if (test.id === 'local.owned-write') attempts.push({status: 'passed', message: '仅在本轮专有 sandbox 写入；不写入游戏、XXMI 或日常 Mod 目录'});
              else {
                attempts.push(await execute(test, context, directory, options.signal));
                if (attempts[0].status === 'failed' && !options.signal?.aborted) {
                  const retryContext = await probe(config, game, options.signal);
                  attempts.push(retryContext.stability === 'stable' && retryContext.observationKey === context.observationKey ? await execute(test, retryContext, directory, options.signal) : {status: 'inconclusive', message: '重试前上下文变化，停止归因'});
                }
              }
              results.push({id: test.id, layer, required: test.required || (REQUIRED[layer] as readonly string[]).includes(test.id), attempts});
            }
          }
        } catch (error) { results.push({id: 'runner.interruption', layer: 'L1', required: true, attempts: [{status: 'inconclusive', message: (error as Error).message}]}); }
        finally {
          const restored = await journal.restore();
          recovery = restored.complete && !pending.length ? 'complete' : 'blocked';
          results.push({id: 'recovery.owned', layer: 'L4', required: true, attempts: [{status: recovery === 'complete' ? 'passed' : 'inconclusive', message: restored.conflicts.join('; ') || (pending.length ? '上轮现场待恢复' : '本轮拥有的测试文件已恢复')}]});
        }
        try { const end = await probe(config, game, options.signal); if (end.stability === 'stable' && end.observationKey === context.observationKey) endRunKey = end.runKey; }
        catch { /* An interrupted end probe can never produce compatibility. */ }
        const selectedVerdict = evaluateRun(context, endRunKey, results, recovery, layers);
        const verdict = evaluateRun(context, endRunKey, results, recovery, LAYERS);
        const report: RunReport = {schemaVersion: 1, runId, startedAt, finishedAt: new Date().toISOString(), context, endRunKey, scope, results, recovery, selectedVerdict, verdict, exitCode: selectedVerdict === 'compatible' ? 0 : selectedVerdict === 'incompatible' ? 1 : 2};
        await saveJson(path.join(directory, 'report.json'), report, true);
        return {report, directory};
      });
    },
  };
}
export type Runner = ReturnType<typeof createRunner>;
