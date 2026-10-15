import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const repo = process.cwd(), output = path.join(repo, '.run-data/compat-sdk');
const root = path.join(output, 'cli-smoke', new Date().toISOString().replaceAll(/[:.]/g, '-'));
async function write(file, value) {await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));}
async function cli(name, args, exitCode) {
  const child = spawn(process.execPath, [path.join(repo, 'node_modules/tsx/dist/cli.mjs'), path.join(repo, 'dev/compat-sdk/cli/index.ts'), ...args], {cwd: repo, windowsHide: true});
  let stdout = '', stderr = '';
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const timer = setTimeout(() => child.kill(), 120000);
  const code = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', resolve);}).finally(() => clearTimeout(timer));
  await write(path.join(root, name + '.json'), {args, code, stdout, stderr});
  assert.equal(code, exitCode, name + ': ' + stderr + stdout);
  if (name.startsWith('watch-')) return stdout.trim() ? stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
  return stdout.trim() ? JSON.parse(stdout.trim()) : null;
}

await fs.mkdir(root, {recursive: true});
const config = {schemaVersion: 1, machineProfile: 'controlled-cli-' + randomUUID(), games: {}, stableDelayMs: 100, pollMs: 1000};
for (const game of ['zzz', 'endfield']) {
  const base = path.join(root, game), gameRoot = path.join(base, 'Game'), xxmiRoot = path.join(base, 'XXMI'), importer = game === 'zzz' ? 'ZZMI' : 'EFMI';
  // Copies a standard Windows executable solely as a valid PE read sample; it is never executed.
  await fs.mkdir(gameRoot, {recursive: true});
  const pe = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/notepad.exe') : process.execPath;
  await fs.copyFile(pe, path.join(gameRoot, game === 'zzz' ? 'ZenlessZoneZero.exe' : 'Endfield.exe'));
  await write(path.join(xxmiRoot, 'Resources/Bin/XXMI Launcher.exe'), 'fixture only, never execute');
  for (const name of ['Launcher', 'XXMI', importer]) await write(path.join(xxmiRoot, 'Resources/Packages', name, 'Manifest.json'), JSON.stringify({version: name === importer ? '1.2.3' : '0.8.8'}));
  await write(path.join(xxmiRoot, 'XXMI Launcher Config.json'), JSON.stringify({Secrets: {token: 'controlled-secret-not-exported'}, Importers: {[importer]: {Importer: {game_folder: gameRoot, importer_folder: importer}}}}));
  await write(path.join(xxmiRoot, importer, 'd3dx.ini'), '[Include]\ninclude_recursive = Mods\nexclude_recursive = DISABLED*\n');
  await write(path.join(xxmiRoot, importer, 'Core', importer, 'main.ini'), 'global $version = 1.23\n');
  await fs.mkdir(path.join(xxmiRoot, importer, 'Mods'));
  config.games[game] = {gameRoot, xxmiRoot, channel: 'controlled-not-live'};
}
const configFile = path.join(root, 'config.json'); await write(configFile, JSON.stringify(config));
const common = ['--config', configFile];
const checks = [];
for (const game of ['zzz', 'endfield']) {
  const inspection = await cli(game + '-inspect', ['inspect', '--game', game, ...common], 0);
  assert.equal(inspection.stability, 'stable'); assert.equal(inspection.game.releaseVersion, null); assert.equal(inspection.xxmi.versions.core, '1.2.3');
  assert.ok(!JSON.stringify(inspection).includes('controlled-secret-not-exported'));
  const local = await cli(game + '-local', ['run', '--game', game, '--suite', 'local', ...common], 0);
  assert.equal(local.selectedVerdict, 'compatible'); assert.equal(local.gameCompatibility, 'inconclusive');
  const full = await cli(game + '-full', ['run', '--game', game, '--suite', 'full', ...common], 2);
  assert.equal(full.gameCompatibility, 'inconclusive'); assert.ok(full.cases.some(c => c.id === 'live.lifecycle' && c.statuses.includes('inconclusive')));
  const task = await cli(game + '-triage', ['triage', '--run', full.report], 0); assert.equal(task.created, false);
  await cli(game + '-baseline-refused', ['baseline', 'approve', '--run', full.report, '--reviewed'], 2);
  const report = JSON.parse(await fs.readFile(local.report, 'utf8'));
  assert.equal(report.recovery, 'complete');
  assert.equal((await cli(game + '-recover', ['recover', '--sandbox', path.join(path.dirname(local.report), 'sandbox')], 0)).complete, true);
  checks.push({game, inspection: game + '-inspect.json', local: local.report, full: full.report, restoration: report.recovery});
}
// One notification per changed stable build. Repeated foreground invocation reads persistent state.
const first = await cli('watch-first', ['watch', '--once', ...common], 2);
assert.equal(first.length, 2);
assert.equal((await cli('watch-dedup', ['watch', '--once', ...common], 2)).length, 0);
await write(path.join(root, 'report.json'), {pass: true, scope: 'controlled CLI only; no real game/XXMI launch', checks, noRealGameLaunched: true});
console.log(JSON.stringify({pass: true, report: path.join(root, 'report.json')}));
