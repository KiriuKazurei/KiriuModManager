import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {parseConfig} from '../dev/compat-sdk/core/config';
import {OUTPUT, REPO, hashFile, outputPath, sha, withLock} from '../dev/compat-sdk/core/files';
import {probeContext, stableContext} from '../dev/compat-sdk/adapters/context';
import {createRunner, evaluateRun, REQUIRED} from '../dev/compat-sdk/core/runner';
import {RecoveryJournal, pendingRecovery} from '../dev/compat-sdk/core/recovery';
import {approveBaseline, createFixTask} from '../dev/compat-sdk/core/tasks';
import {watch} from '../dev/compat-sdk/core/watch';
import {evaluateReferenceFrames, type Frame, type ReferenceRules} from '../dev/compat-sdk/core/visual';
import {LAYERS, SDK_VERSION, type CaseResult, type Config, type Context, type TestCase} from '../dev/compat-sdk/core/types';

const passed = () => ({status: 'passed' as const, message: 'controlled test evidence, not live game'});
const config = (): Config => ({schemaVersion: 1, machineProfile: randomUUID(), games: {endfield: {gameRoot: path.join(OUTPUT, 'fixture-game'), channel: 'controlled'}}, stableDelayMs: 1, pollMs: 1});
function context(): Context {
  return {schemaVersion: 1, sdkVersion: SDK_VERSION, gameId: 'endfield', channel: 'controlled', observedAt: new Date().toISOString(), stability: 'stable', source: {commit: 'test', digest: sha('source')}, machine: {profile: 'controlled', platform: process.platform, arch: process.arch, release: 'test', node: process.version}, game: {root: OUTPUT, executable: path.join(OUTPUT, 'never-executed.exe'), releaseVersion: null, buildKey: sha('build'), files: [], pe: null, coverage: ['controlled, no live evidence']}, xxmi: {installed: true, modsDirectories: [], versions: {}, files: [], rulesConfirmed: true}, fixtures: {revision: sha('controlled-fixture'), sceneRevision: sha('controlled-scene')}, observationKey: sha('observation'), runKey: sha('run'), issues: []};
}
function results(): CaseResult[] { return LAYERS.flatMap(layer => REQUIRED[layer].map(id => ({id, layer, required: true, attempts: [passed()]}))); }
async function folder() { const root = outputPath('unit', randomUUID()); await fs.mkdir(root, {recursive: true}); return root; }
async function write(file: string, value: string | Buffer) { await fs.mkdir(path.dirname(file), {recursive: true}); await fs.writeFile(file, value); }
function registered(except?: Partial<TestCase>) {
  const runner = createRunner();
  runner.registerSuite(LAYERS.filter(l => l !== 'L4').flatMap(layer => REQUIRED[layer].map(id => ({id, layer, required: true, timeoutMs: 5000, run: async () => passed(), ...(except?.id === id ? except : {})}))));
  return runner;
}
async function fixture(game: 'zzz' | 'endfield' = 'endfield') {
  const root = await folder(), gameRoot = path.join(root, 'Game'), xxmiRoot = path.join(root, 'XXMI'), importer = game === 'zzz' ? 'ZZMI' : 'EFMI';
  const exe = path.join(gameRoot, game === 'zzz' ? 'ZenlessZoneZero.exe' : 'Endfield.exe');
  await write(exe, 'controlled executable bytes; never launch');
  await write(path.join(gameRoot, 'config.ini'), Buffer.from([0, 255, 17, 2]));
  await write(path.join(xxmiRoot, 'Resources/Bin/XXMI Launcher.exe'), 'never launch');
  for (const name of ['Launcher', 'XXMI', importer]) await write(path.join(xxmiRoot, 'Resources/Packages', name, 'Manifest.json'), JSON.stringify({version: name === importer ? '1.2.3' : '0.8.8'}));
  await write(path.join(xxmiRoot, 'XXMI Launcher Config.json'), JSON.stringify({Secrets: {token: 'SECRET-DO-NOT-EXPORT'}, Importers: {[importer]: {Importer: {importer_folder: importer, game_folder: gameRoot}}}}));
  await write(path.join(xxmiRoot, importer, 'd3dx.ini'), '[Include]\ninclude_recursive = Mods\nexclude_recursive = DISABLED*\n');
  await write(path.join(xxmiRoot, importer, 'Core', importer, 'main.ini'), 'global $version = 1.23\n');
  await fs.mkdir(path.join(xxmiRoot, importer, 'Mods'));
  const cfg = {...config(), games: {[game]: {gameRoot, xxmiRoot, channel: 'controlled'}}};
  const probe = () => probeContext(cfg, game, {peReader: async () => null});
  return {root, cfg, gameRoot, xxmiRoot, importer, exe, probe};
}

test('SDK config rejects unknown games, commands, disk roots and invalid intervals', () => {
  assert.equal(parseConfig({...config(), stableDelayMs: 100, pollMs: 1000}).schemaVersion, 1);
  for (const change of [{schemaVersion: 2}, {execute: 'unsafe'}, {pollMs: 0}, {games: {other: {}}}, {games: {endfield: {gameRoot: path.parse(OUTPUT).root, channel: 'test'}}}]) assert.throws(() => parseConfig({...config(), stableDelayMs: 100, pollMs: 1000, ...change}));
});
test('SDK hash is content based, bounded and does not execute EXEs', async () => {
  const root = await folder(), file = path.join(root, 'fake.exe'); await write(file, 'one');
  const a = await hashFile(file); await write(file, 'two'); const b = await hashFile(file);
  assert.notEqual(a.digest, b.digest); await assert.rejects(hashFile(file, 1), /预算/);
  await assert.rejects(hashFile(root), /类型/);
  const ctrl = new AbortController(); ctrl.abort(); await assert.rejects(hashFile(file, 100, ctrl.signal));
});
for (const game of ['zzz', 'endfield'] as const) test(`SDK ${game}: known component formats and importer input, opaque config is not release version`, async () => {
  const f = await fixture(game), a = await f.probe();
  assert.equal(a.game.releaseVersion, null); assert.equal(a.xxmi.versions.core, '1.2.3'); assert.equal(a.xxmi.rulesConfirmed, true); assert.equal(a.issues.length, 0);
  assert.ok(!JSON.stringify(a).includes('SECRET-DO-NOT-EXPORT'));
  f.cfg.games[game]!.xxmiRoot = path.join(f.xxmiRoot, f.importer);
  const b = await f.probe(); assert.equal(b.xxmi.root, f.xxmiRoot); assert.equal(b.runKey, a.runKey);
});
test('SDK distinguishes manifest/core conflict, same-version patch and file-time hints', async () => {
  const f = await fixture(), a = await f.probe();
  await fs.utimes(f.exe, new Date(), new Date(Date.now() + 10000));
  const touched = await f.probe(); assert.equal(touched.runKey, a.runKey); assert.notEqual(touched.observationKey, a.observationKey);
  await write(f.exe, 'same nominal game version, new content'); assert.notEqual((await f.probe()).runKey, a.runKey);
  await write(path.join(f.xxmiRoot, f.importer, 'Core', f.importer, 'main.ini'), 'global $version = 1.24\n');
  assert.ok((await f.probe()).issues.some(s => s.includes('来源矛盾')));
});
test('SDK moving identical installations changes path guards but not semantic build/run key', async () => {
  const f = await fixture(), a = await f.probe(), moved = path.join(f.root, 'MovedGame');
  await fs.rename(f.gameRoot, moved); f.cfg.games.endfield!.gameRoot = moved;
  await write(path.join(f.xxmiRoot, 'XXMI Launcher Config.json'), JSON.stringify({Importers: {EFMI: {Importer: {game_folder: moved, importer_folder: 'EFMI'}}}}));
  const b = await f.probe(); assert.equal(a.game.buildKey, b.game.buildKey); assert.equal(a.runKey, b.runKey); assert.notEqual(a.observationKey, b.observationKey);
});
test('SDK stable observation rejects changing snapshots and accepts two matching snapshots', async () => {
  let n = 0; const cfg = config();
  const changing = async () => ({...context(), observationKey: sha(String(n++))});
  assert.equal((await stableContext(cfg, 'endfield', undefined, changing)).stability, 'updating');
  assert.equal((await stableContext(cfg, 'endfield', undefined, async () => context())).stability, 'unknown'); // no real file evidence
});
test('SDK never infers compatibility from omitted, skipped or duplicate required cases', () => {
  const c = context(), rs = results(); assert.equal(evaluateRun(c, c.runKey, rs, 'complete', LAYERS), 'compatible');
  for (const id of rs.map(r => r.id)) assert.equal(evaluateRun(c, c.runKey, rs.filter(r => r.id !== id), 'complete', LAYERS), 'inconclusive');
  const skipped = results(); skipped[0].attempts[0].status = 'skipped'; assert.equal(evaluateRun(c, c.runKey, skipped, 'complete', LAYERS), 'inconclusive');
  assert.equal(evaluateRun(c, c.runKey, [...rs, rs[0]], 'complete', LAYERS), 'inconclusive');
  assert.equal(evaluateRun(c, c.runKey, rs, 'blocked', LAYERS), 'inconclusive');
  assert.equal(evaluateRun(c, sha('changed'), rs, 'complete', LAYERS), 'inconclusive');
  assert.equal(evaluateRun({...c, fixtures: {revision: 'unconfigured', sceneRevision: 'unconfigured'}}, c.runKey, rs, 'complete', LAYERS), 'inconclusive');
});
test('SDK failure requires repeatability, valid control, attribution and evidence; flakiness stays inconclusive', () => {
  const c = context(), rs = results(); const bad = {status: 'failed' as const, message: 'not enabled', controlPassed: true, attribution: 'manager' as const, evidence: ['proof.json']};
  rs[1].attempts = [bad]; assert.equal(evaluateRun(c, c.runKey, rs, 'complete', LAYERS), 'inconclusive');
  rs[1].attempts = [bad, bad]; assert.equal(evaluateRun(c, c.runKey, rs, 'complete', LAYERS), 'incompatible');
  for (const next of [{...bad, controlPassed: false}, {...bad, attribution: 'environment' as const}, {...bad, evidence: []}, passed()]) {rs[1].attempts = [bad, next]; assert.equal(evaluateRun(c, c.runKey, rs, 'complete', LAYERS), 'inconclusive');}
});
test('SDK recovery restores bytes, reopens WAL, refuses outside writes and external changes', async () => {
  const root = await folder(), journal = await RecoveryJournal.create(root), file = path.join(journal.root, 'work/value.ini');
  await write(file, Buffer.from([255, 254, 65, 0])); const original = await fs.readFile(file);
  await journal.write('value.ini', Buffer.from('new')); await assert.rejects(journal.write('../escape', Buffer.from('bad')));
  await assert.rejects(journal.write('value.ini', Buffer.from('duplicate')));
  assert.equal((await (await RecoveryJournal.open(journal.root)).restore()).complete, true); assert.deepEqual(await fs.readFile(file), original);
  const root2 = await folder(), j2 = await RecoveryJournal.create(root2); await j2.write('created.ini', Buffer.from('sdk'));
  await write(path.join(j2.root, 'work/created.ini'), 'external edit'); assert.equal((await j2.restore()).complete, false); assert.equal(await fs.readFile(path.join(j2.root, 'work/created.ini'), 'utf8'), 'external edit');
  await assert.rejects(RecoveryJournal.open(path.dirname(OUTPUT)));
});
test('SDK pending recovery is detected across games and only the exact owned sandbox can recover', async () => {
  const run = outputPath('zzz', 'unit-pending-' + randomUUID()), journal = await RecoveryJournal.create(run);
  await journal.write('probe', Buffer.from('owned')); assert.ok((await pendingRecovery()).includes(journal.root));
  await assert.rejects(RecoveryJournal.create(run));
  assert.equal((await (await RecoveryJournal.open(journal.root)).restore()).complete, true); assert.ok(!(await pendingRecovery()).includes(journal.root));
});
test('SDK execution lock prevents simultaneous owners without deleting another owner lock', async () => {
  let release!: () => void; const pending = new Promise<void>(r => release = r); const name = 'unit-' + randomUUID();
  const first = withLock(name, () => pending); await delay(30);
  await assert.rejects(withLock(name, async () => 1), /exist|EEXIST/i); release(); await first;
  assert.equal(await withLock(name, async () => 2), 2);
});
test('SDK source-only/local success is not full game compatibility and real layers remain missing', async () => {
  const runner = registered(); const probe = async () => context();
  const {report} = await runner.run(config(), 'endfield', 'local', {probe});
  assert.equal(report.exitCode, 0); assert.equal(report.selectedVerdict, 'compatible'); assert.equal(report.verdict, 'inconclusive'); assert.equal(report.recovery, 'complete');
  const empty = createRunner(); const full = await empty.run(config(), 'endfield', 'full', {probe}); assert.equal(full.report.exitCode, 2);
});
test('SDK retries only failed case once and generates one local task with verified evidence', async () => {
  let n = 0;
  const runner = registered({id: 'local.integration', run: async (_c, _s, tools) => {
    n++; const proof = path.join(tools.directory, 'proof.json'); await write(proof, '{"expected":"enabled","actual":"disabled"}');
    return {status: 'failed', message: 'physical folder remains disabled', attribution: 'manager', controlPassed: true, evidence: [proof]};
  }});
  const c = {...context(), runKey: sha(randomUUID())};
  const {report, directory} = await runner.run(config(), 'endfield', 'local', {probe: async () => c}); assert.equal(n, 2); assert.equal(report.selectedVerdict, 'incompatible');
  const task = await createFixTask(path.join(directory, 'report.json')); assert.equal(task.created, true);
  assert.equal((await createFixTask(path.join(directory, 'report.json'))).created, false);
  assert.ok((await fs.readFile(path.join(task.directory!, 'fix-task.md'), 'utf8')).includes('不自动提交'));
});
test('SDK changed context before retry blocks defect attribution and task generation', async () => {
  let n = 0; const runner = registered({id: 'local.integration', run: async () => ({status: 'failed', message: 'assertion', attribution: 'manager', controlPassed: true, evidence: ['proof']})});
  const c = context(); const result = await runner.run(config(), 'endfield', 'local', {probe: async () => ({...c, observationKey: sha(String(n++))})});
  assert.equal(result.report.selectedVerdict, 'inconclusive'); assert.equal((await createFixTask(path.join(result.directory, 'report.json'))).created, false);
});
test('SDK cooperative timeout remains inconclusive and restores owned files', async () => {
  const runner = registered({id: 'local.integration', timeoutMs: 5, run: async (_c, signal) => {await delay(50, undefined, {signal}); return passed();}});
  const {report} = await runner.run(config(), 'endfield', 'local', {probe: async () => context()}); assert.equal(report.selectedVerdict, 'inconclusive'); assert.equal(report.recovery, 'complete');
});
test('SDK watch is serial, deduplicates stable builds, retests content changes and stays quiet on passes', async () => {
  const cfg = config(), runner = registered(), notices: unknown[] = []; let c = context(); const probe = async () => c;
  assert.equal((await watch(cfg, runner, {once: true, probe, onResult: r => notices.push(r)})).runs, 1);
  assert.equal((await watch(cfg, runner, {once: true, probe, onResult: r => notices.push(r)})).runs, 0); assert.equal(notices.length, 0);
  c = {...c, runKey: sha('next'), observationKey: sha('next-observation')}; assert.equal((await watch(cfg, runner, {once: true, probe})).runs, 1);
  c = {...c, stability: 'updating'};
  const waiting: unknown[] = [];
  const incomplete = await watch(cfg, runner, {once: true, probe, onResult: r => waiting.push(r)});
  assert.equal(incomplete.runs, 0); assert.equal(incomplete.exitCode, 2);
  assert.equal((await watch(cfg, runner, {once: true, probe, onResult: r => waiting.push(r)})).exitCode, 2); assert.equal(waiting.length, 1);
});
test('SDK does not approve baseline without reviewed real lifecycle/scene evidence', async () => {
  const runner = registered(), {directory} = await runner.run(config(), 'endfield', 'local', {probe: async () => context()});
  await assert.rejects(approveBaseline(path.join(directory, 'report.json'), false), /reviewed/);
  await assert.rejects(approveBaseline(path.join(directory, 'report.json'), true), /不齐全|真实/);
  await assert.rejects(createFixTask(path.join(OUTPUT, '../outside/report.json')), /工作区/);
});
test('SDK actual owned helper termination leaves a recoverable write-ahead log', async t => {
  const root = await folder(), script = path.join(root, 'crash-fixture.ts');
  await write(script, `import {RecoveryJournal} from ${JSON.stringify(path.join(REPO, 'dev/compat-sdk/core/recovery.ts'))};\n(async()=>{ const j=await RecoveryJournal.create(${JSON.stringify(root)}); await j.write('interrupted.ini', Buffer.from('owned-test')); console.log('READY'); setInterval(()=>{},1000); })().catch(e=>{console.error(e);process.exit(1)});`);
  const child = spawn(process.execPath, [path.join(REPO, 'node_modules/tsx/dist/cli.mjs'), script], {cwd: REPO, windowsHide: true});
  let log = '';
  t.after(() => {if (child.exitCode === null) child.kill('SIGKILL');});
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('helper readiness timeout: ' + log)), 15000);
    child.stdout.on('data', b => {log += b.toString(); if (log.includes('READY')) {clearTimeout(timer); resolve();}});
    child.stderr.on('data', b => log += b.toString());
    child.once('error', e => {clearTimeout(timer); reject(e);});
    child.once('exit', () => {clearTimeout(timer); if (!log.includes('READY')) reject(new Error(log));});
  });
  await ready; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const j = await RecoveryJournal.open(path.join(root, 'sandbox'));
  assert.equal(await fs.readFile(path.join(j.root, 'work/interrupted.ini'), 'utf8'), 'owned-test');
  assert.equal((await j.restore()).complete, true); await assert.rejects(fs.stat(path.join(j.root, 'work/interrupted.ini')), /ENOENT/);
});
test('SDK A/B/A combines same-window scene anchors, regional changes, restoration and independent signals', () => {
  const frame = (): Frame => ({width: 4, height: 2, rgba: new Uint8Array(32).fill(100), scene: 'fixed', windowIdentity: 'owned-pid/exe/window'});
  const before = frame(), enabled = frame(), after = frame(); enabled.rgba.set([250, 250, 250, 255], 12);
  const rules: ReferenceRules = {scene: 'fixed', anchor: {x: 0, y: 0, width: 1, height: 1}, target: {x: 3, y: 0, width: 1, height: 1}, maxAnchorDelta: 0.01, maxRestoredDelta: 0.01, minEnabledDelta: 0.2, minBrightness: 0.05};
  const runtime = {controlReady: true, fixtureLoaded: true, evidence: ['window-captures', 'fixture-log']};
  assert.equal(evaluateReferenceFrames({before, enabled, after}, rules, runtime).status, 'passed');
  assert.equal(evaluateReferenceFrames({before, enabled: before, after}, rules, runtime).status, 'failed');
  assert.equal(evaluateReferenceFrames({before, enabled, after: enabled}, rules, runtime).status, 'failed');
  assert.equal(evaluateReferenceFrames({before, enabled, after}, rules, {...runtime, fixtureLoaded: null}).status, 'inconclusive');
  assert.equal(evaluateReferenceFrames({before, enabled, after}, rules, {...runtime, controlReady: false}).status, 'inconclusive');
  assert.equal(evaluateReferenceFrames({before, enabled: {...enabled, windowIdentity: 'other'}, after}, rules, runtime).status, 'inconclusive');
  assert.equal(evaluateReferenceFrames({before, enabled: {...enabled, scene: 'login'}, after}, rules, runtime).status, 'inconclusive');
  const moved = frame(); moved.rgba.fill(250, 0, 3); assert.equal(evaluateReferenceFrames({before, enabled: moved, after}, rules, runtime).status, 'inconclusive');
  const black = frame(); black.rgba.fill(0); assert.equal(evaluateReferenceFrames({before: black, enabled: black, after: black}, rules, runtime).status, 'inconclusive');
});
