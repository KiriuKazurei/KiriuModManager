import { promises as fs } from 'node:fs';
import path from 'node:path';
import { GameId, GamePaths, GAMES, Inspection } from '../shared/contracts';
import { inspectXXMI, parseRecursiveIncludes, resolveLoaderPath } from './xxmi';
import { assertNoLinks } from './archive';
type JsonObject = Record<string, any>;
const dictionary = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('XXMI 配置结构无效，原文件未修改。');
  return value as JsonObject;
};
export function patchFirstRecursiveInclude(contents: string, value: string): string {
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const lines = contents.split(/\r?\n/); let section = false; let replaced = false; let sectionEnd = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.startsWith('[')) {
      if (section && sectionEnd < 0) sectionEnd = index;
      section = /^\[Include\]\s*(?:;.*)?$/i.test(line);
    }
    if (section && !replaced && /^include_recursive\s*=/i.test(line)) {
      const match = /^(\s*include_recursive\s*=\s*)(.*?)(\s*;.*)?$/i.exec(lines[index]);
      lines[index] = `${match?.[1] || 'include_recursive = '}${value}${match?.[3] || ''}`; replaced = true;
    }
  }
  if (!replaced) {
    const heading = lines.findIndex(line => /^\[Include\]\s*(?:;.*)?$/i.test(line.trim()));
    if (heading >= 0) lines.splice(sectionEnd >= 0 ? sectionEnd : lines.length, 0, `include_recursive = ${value}`);
    else lines.push('', '[Include]', `include_recursive = ${value}`);
  }
  return lines.join(newline);
}
export function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (value: string) => value.split('.').map(Number);
  const current = parts(version); const required = parts(minimum);
  for (let i = 0; i < 3; i++) { if (!Number.isFinite(current[i])) return false; if (current[i] !== required[i]) return current[i] > required[i]; }
  return true;
}
export async function validatePaths(gameId: GameId, input: GamePaths): Promise<GamePaths> {
  if (typeof gameId !== 'string' || !Object.hasOwn(GAMES, gameId)) throw new Error('不支持的游戏。');
  const output = {} as GamePaths;
  for (const key of ['xxmiRoot', 'gameDirectory', 'modsDirectory'] as const) {
    const value = input?.[key];
    if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim()) || /[\r\n\0;"*?]/.test(value)) throw new Error('安装位置、游戏目录和 Mod 目录都需要有效的完整绝对路径。');
    output[key] = path.resolve(value.trim()); await assertNoLinks(output[key]);
  }
  if(output.modsDirectory===path.parse(output.modsDirectory).root)throw new Error('Mod 目录不能直接使用磁盘根目录，请选择专用文件夹。');
  if (!(await fs.stat(output.gameDirectory)).isDirectory()) throw new Error('游戏目录不存在，请先选择游戏安装位置。');
  const names = gameId === 'zzz' ? ['ZenlessZoneZero.exe', 'ZenlessZoneZeroBeta.exe'] : ['Endfield.exe'];
  let found = false;
  for (const name of names) {
    try { if ((await fs.stat(path.join(output.gameDirectory, name))).isFile()) { found = true; break; } } catch { /* try other known executable */ }
  }
  if (!found) {
    // Official ModelImporter.validate_game_exe_path also accepts one unique nested executable.
    let matches = 0; let directories = 0;
    const walk = async (directory: string): Promise<void> => {
      if (++directories > 10000) throw new Error('游戏目录范围过大，请直接选择包含游戏 EXE 的安装目录。');
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && names.includes(entry.name)) matches++;
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path.join(directory, entry.name));
      }
    };
    await walk(output.gameDirectory); found = matches === 1;
  }
  if (!found) throw new Error(`未找到唯一的 ${names.join(' / ')}。请选择${GAMES[gameId].name}的实际游戏安装目录。`);
  // Do not write importer files into a game installation or a drive root.
  if (output.xxmiRoot === path.parse(output.xxmiRoot).root || output.gameDirectory === output.xxmiRoot || !path.relative(output.gameDirectory, output.xxmiRoot).startsWith('..') && !path.isAbsolute(path.relative(output.gameDirectory, output.xxmiRoot))) throw new Error('XXMI 安装位置必须与游戏目录分开，且不能是磁盘根目录。');
  if (output.modsDirectory === output.xxmiRoot || output.modsDirectory === output.gameDirectory) throw new Error('Mod 目录不能直接使用 XXMI 根目录或游戏目录。');
  return output;
}
export async function syncXXMIPaths(gameId: GameId, input: GamePaths, deployedSignatures?: Record<string, string>): Promise<{ inspection: Inspection; backupDirectory: string }> {
  const fields = await validatePaths(gameId, input);
  const inspection = await inspectXXMI(gameId, fields.xxmiRoot);
  if (!inspection.installed) throw new Error('未检测到完整的所选游戏组件，请先安装 XXMI。');
  await assertNoLinks(inspection.importerDirectory); await assertNoLinks(inspection.iniPath);
  const configPath = path.join(fields.xxmiRoot, 'XXMI Launcher Config.json'); await assertNoLinks(configPath);
  let raw = '';
  try { raw = await fs.readFile(configPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let config: JsonObject;
  try { config = raw ? dictionary(JSON.parse(raw.replace(/^\uFEFF/, ''))) : {}; }
  catch { throw new Error('XXMI 配置无法解析，原文件未修改。'); }
  const importers = config.Importers === undefined ? config.Importers = {} : dictionary(config.Importers);
  const name = GAMES[gameId].importer;
  const selected = importers[name] === undefined ? importers[name] = {} : dictionary(importers[name]);
  const importer = selected.Importer === undefined ? selected.Importer = {} : dictionary(selected.Importer);
  const ini = await fs.readFile(inspection.iniPath, 'utf8');
  const currentMods = parseRecursiveIncludes(ini)[0];
  const oldPath = currentMods ? resolveLoaderPath(inspection.importerDirectory, currentMods) : '';
  const changingMods = oldPath.toLowerCase() !== fields.modsDirectory.toLowerCase();
  let librariesVersion = '';
  try { const version = JSON.parse(await fs.readFile(path.join(fields.xxmiRoot, 'Resources', 'Packages', 'XXMI', 'Manifest.json'), 'utf8')).version; if (typeof version === 'string') librariesVersion = version; } catch { /* explicitly unsupported below */ }
  if (changingMods && !versionAtLeast(librariesVersion, '1.2.0')) throw new Error('自定义 Mod 路径同步需要 XXMI 库 1.2.0 或更新版本。请先在官方 Launcher 更新组件；当前可继续使用 loader 已有目录。原文件未修改。');
  const overrides = importer.d3dx_ini === undefined ? importer.d3dx_ini = {} : dictionary(importer.d3dx_ini);
  const core = overrides.core === undefined ? overrides.core = { Loader: { loader: 'XXMI Launcher.exe' } } : dictionary(overrides.core);
  if (!core.Loader) core.Loader = { loader: 'XXMI Launcher.exe' };
  if (versionAtLeast(librariesVersion, '1.2.0')) {
    const include = core.Include === undefined ? core.Include = {} : dictionary(core.Include);
    include.include_recursive = fields.modsDirectory;
  }
  importer.game_folder = fields.gameDirectory;
  importer.importer_folder = path.relative(fields.xxmiRoot, inspection.importerDirectory).replace(/\\/g, '/') || name;
  if (deployedSignatures) importer.deployed_migoto_signatures = { ...(importer.deployed_migoto_signatures || {}), ...deployedSignatures };
  const launcher = config.Launcher === undefined ? config.Launcher = {} : dictionary(config.Launcher);
  if (!Array.isArray(launcher.enabled_importers)) launcher.enabled_importers = [];
  if (!launcher.enabled_importers.includes(name)) launcher.enabled_importers.push(name);
  if (!launcher.active_importer || launcher.active_importer === 'XXMI') launcher.active_importer = name;
  const patched = changingMods ? patchFirstRecursiveInclude(ini, fields.modsDirectory) : ini;
  const backupDirectory = path.join(fields.xxmiRoot, '.kmm-backups', `paths-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  await assertNoLinks(backupDirectory);
  await fs.mkdir(backupDirectory, { recursive: true });
  if (raw) await fs.writeFile(path.join(backupDirectory, 'XXMI Launcher Config.json'), raw, { mode: 0o600 });
  await fs.writeFile(path.join(backupDirectory, 'd3dx.ini'), ini);
  await fs.mkdir(fields.modsDirectory, { recursive: true });
  try {
    if (patched !== ini) await fs.writeFile(inspection.iniPath, patched, 'utf8');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    try { if (patched !== ini) await fs.writeFile(inspection.iniPath, ini, 'utf8'); if (raw) await fs.writeFile(configPath, raw, 'utf8'); } catch { /* backups retained for manual restore */ }
    throw new Error(`同步未完成，原文件备份位于 ${backupDirectory}。请检查写入权限。`);
  }
  const updated = await inspectXXMI(gameId, fields.xxmiRoot);
  if (!updated.modsDirectories.some(value => value.toLowerCase() === fields.modsDirectory.toLowerCase())) throw new Error('同步后的 loader 读取目录校验失败，请检查备份与配置。');
  return { inspection: updated, backupDirectory };
}
