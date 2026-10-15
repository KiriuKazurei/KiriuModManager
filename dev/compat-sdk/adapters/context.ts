import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {resolveGameInstallation} from '../../../src/main/game-paths';
import {inspectXXMI} from '../../../src/main/xxmi';
import {inspectInstalledVersions} from '../../../src/main/installed-versions';
import {decodeIni} from '../../../src/main/ini';
import {launchPlan} from '../../../src/main/desktop';
import {fileBytes, isInside} from '../../../src/main/inspection-files';
import type {GameId} from '../../../src/shared/contracts';
import {hashFile, identity, REPO, sha, sourceHashes, treeHashes} from '../core/files';
import {SDK_VERSION, type Config, type Context, type FileEvidence} from '../core/types';

const exec = promisify(execFile);
async function peVersion(file: string): Promise<Context['game']['pe']> {
  if (process.platform !== 'win32') return null;
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const {stdout} = await exec(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'file-version.ps1'), '-TargetPath', file], {timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true});
  const v = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  if (typeof v.fileVersion !== 'string' || typeof v.productVersion !== 'string') return null;
  return {fileVersion: v.fileVersion.slice(0, 200), productVersion: v.productVersion.slice(0, 200)};
}

export async function probeContext(config: Config, gameId: GameId, options: {signal?: AbortSignal; peReader?: typeof peVersion} = {}): Promise<Context> {
  const g = config.games[gameId];
  if (!g) throw new Error(`未配置 ${gameId}`);
  const c: Context = {
    schemaVersion: 1, sdkVersion: SDK_VERSION, gameId, channel: g.channel, observedAt: new Date().toISOString(), stability: 'unknown',
    source: {commit: 'unknown', digest: ''}, machine: {profile: config.machineProfile, platform: process.platform, arch: process.arch, release: os.release(), node: process.version},
    game: {root: g.gameRoot, releaseVersion: null, buildKey: '', files: [], pe: null, coverage: ['仅已解析 EXE 和根目录安装清单/配置的内容摘要；不覆盖所有资源或运行时热更新；发行版本未知']},
    xxmi: {installed: false, modsDirectories: [], versions: {}, files: [], rulesConfirmed: false},
    fixtures: {revision: 'unconfigured', sceneRevision: 'unconfigured'}, observationKey: '', runKey: '', issues: [],
  };
  try { c.source.commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: REPO, windowsHide: true, timeout: 5000})).stdout.trim(); }
  catch { c.issues.push('无法读取管理器提交；源码摘要仍单独记录'); }
  c.source.digest = sha(JSON.stringify(await sourceHashes()));
  const read = async (file: string, target: FileEvidence[], optional = false) => {
    try { const f = await hashFile(file, undefined, options.signal); target.push(f); return f; }
    catch (error) { if (!optional || (error as NodeJS.ErrnoException).code !== 'ENOENT') c.issues.push(`无法稳定读取 ${file}: ${(error as Error).message}`); return null; }
  };
  const resolution = await resolveGameInstallation(gameId, g.gameRoot, {signal: options.signal});
  c.issues.push(...resolution.issues);
  if (resolution.complete && resolution.matches.length === 1) {
    c.game.executable = resolution.matches[0].executable;
    await read(c.game.executable, c.game.files);
    try { c.game.pe = await (options.peReader ?? peVersion)(c.game.executable); }
    catch { c.issues.push('EXE 文件版本无法读取（不是游戏发行版本）'); }
    const root = path.dirname(c.game.executable);
    for (const name of gameId === 'endfield' ? ['verify_files.json', 'config.ini'] : ['config.ini']) await read(path.join(root, name), c.game.files, true);
  } else c.issues.push('未确认唯一且完整的游戏 EXE');
  if (g.xxmiRoot) {
    let root = g.xxmiRoot;
    // Accept an importer folder only when its immediate parent has the known Launcher config.
    if (path.basename(root).toUpperCase() === (gameId === 'zzz' ? 'ZZMI' : 'EFMI')) {
      try { await fileBytes(path.join(path.dirname(root), 'XXMI Launcher Config.json')); root = path.dirname(root); }
      catch { /* Keep the supplied directory; inspection will explain missing components. */ }
    }
    c.xxmi.root = root;
    try {
      const info = await inspectXXMI(gameId, root);
      Object.assign(c.xxmi, {installed: info.installed, importerDirectory: info.importerDirectory, launcherPath: info.launcherPath, gameDirectory: info.gameDirectory, modsDirectories: info.modsDirectories});
      c.issues.push(...info.warnings);
      const versions = await inspectInstalledVersions(gameId, root);
      for (const [k, v] of Object.entries(versions)) { c.xxmi.versions[k] = v.version; if (v.path) await read(v.path, c.xxmi.files, true); }
      await read(info.launcherPath, c.xxmi.files, true);
      await read(info.iniPath, c.xxmi.files);
      for (const name of ['d3d11.dll', 'd3dcompiler_47.dll', 'd3dx_user.ini']) await read(path.join(info.importerDirectory, name), c.xxmi.files, true);
      try {
        const coreRoot = path.join(info.importerDirectory, 'Core');
        for (const file of Object.keys(await treeHashes(coreRoot))) await read(path.join(coreRoot, file), c.xxmi.files);
      } catch { c.issues.push('Importer Core 内容摘要未完成'); }
      if (info.installed) {
        try { c.xxmi.launchPlan = await launchPlan(gameId, {xxmiRoot: root, gameDirectory: g.gameRoot, modsDirectory: info.modsDirectories[0] ?? ''}, 'game'); }
        catch (error) { c.issues.push(`固定启动计划未确认: ${(error as Error).message}`); }
      }
      // Keep only the selected public fields of Launcher config, never raw credentials or raw JSON digests.
      const publicConfig = {gameDirectory: info.gameDirectory, importerDirectory: info.importerDirectory, modsDirectories: info.modsDirectories};
      c.xxmi.versions.publicConfigDigest = sha(JSON.stringify(publicConfig));
      if (info.gameDirectory) {
        const target = await resolveGameInstallation(gameId, info.gameDirectory, {signal: options.signal});
        if (!target.complete || target.matches.length !== 1 || path.resolve(target.matches[0].executable) !== c.game.executable) c.issues.push('Launcher 目标与本次已解析游戏不一致');
      }
      const ini = decodeIni(await fileBytes(info.iniPath, 4 * 1024 ** 2)).text;
      c.xxmi.rulesConfirmed = /^\s*exclude_recursive\s*=\s*DISABLED\*\s*(?:;.*)?$/im.test(ini) && info.modsDirectories.length > 0 && info.modsExist.every(Boolean);
      if (!c.xxmi.rulesConfirmed) c.issues.push('未确认现有 Mod 读取目录及 DISABLED* 排除规则');
      const core = path.join(info.importerDirectory, 'Core', info.importer, 'main.ini');
      if (!c.xxmi.files.some(f => f.path === core)) await read(core, c.xxmi.files);
      const version = /^global \$version\s*=\s*(\d+)\.(\d)(\d*)\s*$/m.exec(decodeIni(await fileBytes(core, 4 * 1024 ** 2)).text);
      if (version) {
        const normalized = `${Number(version[1])}.${Number(version[2])}.${Number(version[3] || '0')}`;
        c.xxmi.versions.core = normalized;
        if (versions.importer.version && versions.importer.version !== normalized) c.issues.push('Importer 核心和安装包版本来源矛盾');
      } else c.issues.push('Importer 核心版本格式未确认');
    } catch (error) { c.issues.push(`组件检查未完成: ${(error as Error).message}`); }
  } else c.issues.push('未配置 XXMI 目录');
  for (const [key, file] of [['revision', g.fixtureRoot], ['sceneRevision', g.sceneFile]] as const) {
    if (!file) continue;
    try { c.fixtures[key] = key === 'revision' ? sha(JSON.stringify(await treeHashes(file))) : (await hashFile(file)).digest; }
    catch { c.issues.push(`无法稳定读取基准 ${key}`); }
  }
  // Absolute paths/stat identities are stability guards, not semantic game-build evidence.
  const semanticFiles = (files: FileEvidence[], base: string) => files.map(f => [isInside(base, f.path) ? path.relative(base, f.path).replaceAll('\\', '/') : path.basename(f.path), f.digest]);
  c.game.buildKey = sha(JSON.stringify(semanticFiles(c.game.files, path.dirname(c.game.executable ?? g.gameRoot))));
  const components = semanticFiles(c.xxmi.files, c.xxmi.root ?? g.gameRoot);
  c.runKey = sha(JSON.stringify([gameId, g.channel, c.game.buildKey, components, c.xxmi.versions.core, c.source, c.machine, c.fixtures]));
  c.observationKey = sha(JSON.stringify([resolution.fingerprint, c.game.files, c.xxmi.files, c.xxmi.versions.publicConfigDigest, c.issues, c.runKey]));
  return c;
}

export async function stableContext(config: Config, game: GameId, signal?: AbortSignal, probe = probeContext): Promise<Context> {
  let previous = await probe(config, game, {signal});
  for (let i = 0; i < 3; i++) {
    await delay(config.stableDelayMs, undefined, {signal});
    const next = await probe(config, game, {signal});
    if (previous.observationKey === next.observationKey) {
      next.stability = !next.game.executable || !next.game.files.length || next.issues.some(s => /摘要期间|摘要预算|文件增长|无法稳定读取|来源矛盾|核心版本格式/.test(s)) ? 'unknown' : 'stable';
      return next;
    }
    previous = next;
  }
  return {...previous, stability: 'updating', issues: [...previous.issues, '有限观察内未取得两次一致快照']};
}

export async function recheckFiles(context: Context) {
  for (const f of [...context.game.files, ...context.xxmi.files]) {
    try { if (identity(await fs.stat(f.path, {bigint: true})) !== f.identity || (await hashFile(f.path)).digest !== f.digest) return false; }
    catch { return false; }
  }
  return true;
}
