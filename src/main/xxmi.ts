import {decodeIni} from './ini';
import {fileBytes} from './inspection-files';
import {assertNoLinks} from './archive';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { GAMES, GameId, Inspection } from '../shared/contracts';
import {normalizeGamePathInput} from '../shared/path-input';
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
async function exists(target: string, directory = false) {
  try { await assertNoLinks(target);const stat = await fs.stat(target); return directory ? stat.isDirectory() : stat.isFile(); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
}
export function resolveLoaderPath(base: string, value: string): string {
  const normalized = value.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]/g, path.sep);
  return path.resolve(base, normalized);
}
export function parseRecursiveIncludes(contents: string): string[] {
  let include = false;
  const paths: string[] = [];
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[')) { include = /^\[include\]\s*(?:;.*)?$/i.test(line); continue; }
    if (include) {
      const match = /^include_recursive\s*=\s*(.*?)\s*(?:;.*)?$/i.exec(line);
      if (match?.[1]) paths.push(match[1]);
    }
  }
  return paths;
}
export async function inspectXXMI(gameId: GameId, rootInput: string): Promise<Inspection> {
  if (!Object.prototype.hasOwnProperty.call(GAMES, gameId)) throw new Error('不支持的游戏。');
  if (typeof rootInput !== 'string' || !rootInput.trim()) throw new Error('请先选择 XXMI 安装根目录。');
  const original=rootInput.trim().replace(/^"(.*)"$/, '$1').trim();
  if(!path.isAbsolute(original))throw new Error('请先选择 XXMI 安装根目录。');
  await assertNoLinks(original);
  const root = path.resolve(normalizeGamePathInput(gameId,'xxmiRoot',original));
  const importer = GAMES[gameId].importer;
  const launcherPath = path.join(root, 'Resources', 'Bin', 'XXMI Launcher.exe');
  const warnings: string[] = [];
  let config: ObjectValue = {};
  try { config = object(JSON.parse(decodeIni(await fileBytes(path.join(root, 'XXMI Launcher Config.json'))).text)); }
  catch (error) {
    warnings.push((error as NodeJS.ErrnoException).code === 'ENOENT' ? '未找到 Launcher 配置，将按默认 importer 目录检查。' : 'Launcher 配置无法读取或格式无效；仅检查默认目录，未导入游戏路径。');
  }
  // Extract only the selected importer's public path fields; no Secrets leave this process.
  const settings = object(object(object(config.Importers)[importer]).Importer);
  const importerDirectory = path.join(root, importer);
  const configuredImporter=string(settings.importer_folder);
  if(configuredImporter&&resolveLoaderPath(root,configuredImporter).toLowerCase()!==importerDirectory.toLowerCase())warnings.push(`Launcher 配置中的组件路径与根目录下的 ${importer} 不一致，请在 XXMI 中检查组件设置。`);
  const importerExists = await exists(importerDirectory, true);
  const iniPath = path.join(importerDirectory, 'd3dx.ini');
  let modsDirectories: string[] = [];
  let iniExists = false;
  if (importerExists) {
    try {
      const contents = decodeIni(await fileBytes(iniPath,4*1024**2)).text; iniExists = true;
      modsDirectories = [...new Set(parseRecursiveIncludes(contents).map(value => resolveLoaderPath(importerDirectory, value)))];
      if (!modsDirectories.length) warnings.push('d3dx.ini 没有可识别的 [Include] include_recursive 路径；不能确认实际 Mod 目录。');
    } catch { warnings.push(`${importer} 目录已存在，但无法读取 d3dx.ini；不能确认 Mod 读取目录，请在 XXMI 中检查组件。`); }
  } else warnings.push(`XXMI 根目录下缺少 ${importer}，尚未安装${GAMES[gameId].name}组件。请点击“打开 XXMI”，选择${GAMES[gameId].name}并手动点击安装，完成后重新检测。配置中的启用状态不代表已安装。`);
  const launcherExists = await exists(launcherPath);
  if (!launcherExists) warnings.push('未找到 Resources\\Bin\\XXMI Launcher.exe。请确认选择的是 XXMI 外层根目录。');
  const modsExist = await Promise.all(modsDirectories.map(value => exists(value, true)));
  if (modsExist.some(value => !value)) warnings.push('部分 loader 读取目录尚不存在，请检查路径。');
  if (modsDirectories.length > 1) warnings.push('loader 读取多个递归目录，请在下方选择需要管理的目录。');
  const gameDirectory = string(settings.game_folder);
  if (!gameDirectory) warnings.push('Launcher 未配置该游戏目录，可在本管理器中手动保存。');
  else if (!path.isAbsolute(gameDirectory)) warnings.push('Launcher 游戏路径不是绝对路径，请手动确认。');
  else if (!await exists(gameDirectory, true)) warnings.push('Launcher 中的游戏目录不存在，请检查位置。');
  return { gameId, importer, xxmiRoot: root, launcherPath, launcherExists, importerDirectory, importerExists, iniPath, iniExists, gameDirectory, modsDirectories, modsExist, installed: launcherExists && importerExists, warnings };
}
