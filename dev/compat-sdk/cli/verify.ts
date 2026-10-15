import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {hashFile, outputPath, readJson, REPO, saveJson, sha, sourceHashes} from '../core/files';
import {isInside} from '../../../src/main/inspection-files';

// Fixed repository commands only. Config files cannot supply executable commands.
async function main() {
  const run = outputPath('verification', new Date().toISOString().replaceAll(/[:.]/g, '-'));
  await fs.mkdir(run, {recursive: true});
  const before = await sourceHashes();
  const checks: Record<string, {pass: boolean; log: string; digest: string; reused?: boolean; report?: string; reportDigest?: string}> = {};
  for (const [name, script] of [['typecheck', 'typecheck'], ['sdkTypecheck', 'compat:typecheck'], ['tests', 'test'], ['api', 'api:check'], ['build', 'build'], ['window', 'smoke:environment'],['compatWindow','smoke:compatibility']]) {
    const log = path.join(run, name + '.txt');
    const chunks: Buffer[] = [];
    let stdout = '';
    const child = process.platform === 'win32' ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npm.cmd run ${script}`], {cwd: REPO, windowsHide: true}) : spawn('npm', ['run', script], {cwd: REPO});
    child.stdout.on('data', b => {chunks.push(b); stdout += b.toString('utf8');}); child.stderr.on('data', b => chunks.push(b));
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    const code = await new Promise<number | null>((resolve, reject) => {child.once('error', reject); child.once('close', resolve);}).finally(() => clearTimeout(timer));
    const bytes = Buffer.concat(chunks); await fs.writeFile(log, bytes);
    checks[name] = {pass: code === 0, log, digest: sha(bytes)};
    console.log(`${name}: ${code === 0 ? 'passed' : 'FAILED'} (${log})`);
    if (code !== 0) throw new Error(`${name} 未通过`);
    if (name === 'window'||name==='compatWindow') {
      const summary = JSON.parse(stdout.slice(stdout.lastIndexOf('\n{') + 1).trim()) as {pass: boolean; run: string};
      const reportRoot=name==='window'?'.run-data/environment-smoke':'.run-data/process-compatibility-smoke';
      if (!summary.pass || !isInside(path.join(REPO, reportRoot), summary.run)) throw new Error('窗口结果或报告目录无效');
      const report = path.join(summary.run, 'report.json');
      if ((await readJson(report) as {pass?: boolean}).pass !== true) throw new Error('源码窗口报告未通过');
      Object.assign(checks[name], {reused: false, report, reportDigest: (await hashFile(report)).digest});
    }
  }
  const after = await sourceHashes();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('验证期间源码发生变化，不写入有效门禁');
  await saveJson(outputPath('source-gate.json'), {schemaVersion: 1, recordedAt: new Date().toISOString(), hashes: after, checks});
  console.log('source-gate.json saved; game compatibility remains unverified.');
}
main().catch(e => {console.error((e as Error).message); process.exitCode = 2;});
