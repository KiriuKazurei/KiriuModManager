import {promises as fs} from 'node:fs';
import {isInside} from '../../../src/main/inspection-files';
import {outputPath, readJson, sha, sourceHashes} from '../core/files';
import type {Runner} from '../core/runner';
import type {TestCase} from '../core/types';

export async function checkSourceGate() {
  try {
    const gate = await readJson(outputPath('source-gate.json')) as {schemaVersion: number; hashes: Record<string, string>; checks: Record<string, {pass: boolean; log: string; digest: string; report?: string; reportDigest?: string}>};
    const hashes = await sourceHashes();
    if (gate.schemaVersion !== 1 || !gate.hashes || JSON.stringify(gate.hashes) !== JSON.stringify(hashes)) throw new Error('源码/SDK/测试/工具链配置已变更，需要重跑源码门禁');
    for (const name of ['typecheck', 'sdkTypecheck', 'tests', 'api', 'build', 'window','compatWindow']) {
      const c = gate.checks[name];
      if (!c?.pass || !isInside(outputPath('verification'), c.log) && name !== 'window') throw new Error(`缺少可信 ${name} 记录`);
      if (sha(await fs.readFile(c.log)) !== c.digest) throw new Error(`${name} 证据摘要不符`);
      if (c.report && (!c.reportDigest || sha(await fs.readFile(c.report)) !== c.reportDigest)) throw new Error(`${name} 报告摘要不符`);
    }
    return {status: 'passed' as const, message: 'reused：精确源码/SDK/测试/配置摘要匹配的本地门禁（不是游戏内验证）', evidence: [outputPath('source-gate.json')]};
  } catch (error) { return {status: 'inconclusive' as const, message: (error as Error).message, attribution: 'test' as const}; }
}

export function registerLocalSuites(runner: Runner) {
  const tests: TestCase[] = [
    {id: 'source.gate', layer: 'L0', required: true, timeoutMs: 30000, run: checkSourceGate},
    {id: 'local.integration', layer: 'L1', required: true, timeoutMs: 10000, run: async c => {
      const issues = [...c.issues];
      if (!c.xxmi.installed) issues.push('标准 Launcher / Importer 组件不完整');
      if (!c.xxmi.rulesConfirmed) issues.push('未确认 loader 的有效读取和停用规则');
      if (Object.values(c.xxmi.versions).some(v => v === null) || !c.xxmi.versions.core) issues.push('组件版本证据不完整');
      if (issues.length) return {status: 'inconclusive', message: [...new Set(issues)].join('; '), attribution: 'environment'};
      return {status: 'passed', message: '本机唯一游戏 EXE、固定 Launcher 位置、目标路径、INI 规则及组件版本已检查；未启动进程', evidence: [...c.game.files, ...c.xxmi.files].map(f => f.path)};
    }},
    {id: 'local.owned-write', layer: 'L1', required: true, timeoutMs: 10000, run: async () => ({status: 'inconclusive', message: '由执行器在拥有的 sandbox 内验证'})},
  ];
  runner.registerSuite(tests);
}
