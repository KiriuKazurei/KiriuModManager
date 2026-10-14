import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Settings, GamePaths, GAMES, GameId, DesktopPreferences } from '../shared/contracts';
import { validateWebUrl, validateUpdateSource } from './web-links';
import {writeAtomicJson} from './atomic-json';
export function defaultSettings(): Settings {
  const empty = (): GamePaths => ({ xxmiRoot: '', gameDirectory: '', modsDirectory: '' });
  return { version: 1, selectedGame: 'zzz', games: { zzz: empty(), endfield: empty() } };
}
export function validateSettings(value: unknown): Settings {
  const data = value as Settings;
  if (!data || data.version !== 1 || typeof data.selectedGame !== 'string' || !Object.hasOwn(GAMES, data.selectedGame) || !data.games) throw new Error('配置格式不受支持，请检查配置文件。');
  const result = defaultSettings();
  result.selectedGame = data.selectedGame;
  if(data.desktop!==undefined){const preferences=data.desktop;if(!preferences||typeof preferences.closeToTray!=='boolean')throw new Error('桌面设置格式无效。');result.desktop={marketUrl:validateWebUrl(preferences.marketUrl),updateUrl:validateWebUrl(preferences.updateUrl),closeToTray:preferences.closeToTray};if(Object.hasOwn(preferences,'updateSourceUrl'))result.desktop.updateSourceUrl=validateUpdateSource(preferences.updateSourceUrl);}
  for (const id of ['zzz', 'endfield'] as const) {
    const fields = data.games[id];
    if (!fields) throw new Error('配置缺少游戏路径。');
    for (const key of ['xxmiRoot', 'gameDirectory', 'modsDirectory'] as const) {
      if (typeof fields[key] !== 'string' || fields[key].length > 32767 || fields[key].includes('\0')) throw new Error('路径格式不正确。');
      const input = fields[key].trim();
      if (input && !path.isAbsolute(input)) throw new Error('请填写完整的绝对目录路径。');
      result.games[id][key] = input;
    }
  }
  return result;
}
function patchFields(value:unknown,allowed:readonly string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('设置更新必须是字段对象。');
  const keys=Reflect.ownKeys(value);
  if(!keys.length)throw new Error('设置更新不能为空。');
  if(keys.some(key=>typeof key!=='string'||!allowed.includes(key)))throw new Error('设置更新包含未知字段。');
  return value as Record<string,unknown>;
}
export function mergeGamePaths(current:Settings,game:GameId,patch:unknown):Settings{
  if(typeof game!=='string'||!Object.hasOwn(GAMES,game))throw new Error('不支持的游戏。');
  const fields=patchFields(patch,['xxmiRoot','gameDirectory','modsDirectory']);
  return validateSettings({...current,games:{...current.games,[game]:{...current.games[game],...fields}}});
}
export function mergeDesktopPreferences(current:Settings,patch:unknown):Settings{
  const fields=patchFields(patch,['marketUrl','updateUrl','closeToTray','updateSourceUrl']);
  return validateSettings({...current,desktop:{marketUrl:'',updateUrl:'',closeToTray:true,...current.desktop,...fields} as DesktopPreferences});
}
export class SettingsStore {
  readonly file: string;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(directory: string) { this.file = path.join(directory, 'settings.json'); }
  async read(): Promise<Settings> {
    await this.pending;
    try { return validateSettings(JSON.parse(await fs.readFile(this.file, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSettings();
      throw new Error('无法读取本地配置；原文件已保留。请检查 settings.json 的格式和读取权限。');
    }
  }
  save(input: unknown): Promise<Settings> {
    const settings = validateSettings(input);
    const task = this.pending.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeAtomicJson(this.file,JSON.stringify(settings,null,2));
      return settings;
    });
    this.pending = task.catch(() => {});
    return task;
  }
}
