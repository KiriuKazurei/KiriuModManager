import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Settings, GamePaths, GAMES, GameId, DesktopPreferences } from '../shared/contracts';
import { validateWebUrl, validateUpdateSource } from './web-links';
import {writeAtomicJson,writeAtomicFile} from './atomic-json';
import {createHash} from 'node:crypto';
import {assertNoLinks} from './archive';
export function defaultSettings(installDirectory?:string): Settings {
  const empty = (folder:string): GamePaths => ({ xxmiRoot: '', gameDirectory: '', modsDirectory: installDirectory?path.join(installDirectory,'Mods',folder):'' });
  return { version: 1, selectedGame: 'zzz', games: { zzz: empty('ZZZ'), endfield: empty('Endfield') } };
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
  constructor(directory: string,private readonly installDirectory?:string) { this.file = path.join(directory, 'settings.json'); }
  private async withDefaultMods(settings:Settings){
    let changed=false;
    if(this.installDirectory){
      const defaults=defaultSettings(this.installDirectory);
      for(const game of ['zzz','endfield']as const)if(!settings.games[game].modsDirectory){
        const directory=defaults.games[game].modsDirectory;
        await assertNoLinks(directory);
        try{await fs.mkdir(directory,{recursive:true});}
        catch{throw new Error(`无法创建默认 Mod 目录：${directory}。请将管理器放在可写目录后重试；已有配置未更改。`);}
        settings.games[game].modsDirectory=directory;changed=true;
      }
    }
    return {settings,changed};
  }
  private async readCurrent():Promise<Settings>{
    let bytes:Buffer|undefined,settings:Settings;
    try { bytes=await fs.readFile(this.file);settings=validateSettings(JSON.parse(bytes.toString('utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') settings=defaultSettings();
      else throw new Error('无法读取本地配置；原文件已保留。请检查 settings.json 的格式和读取权限。');
    }
    const initialized=await this.withDefaultMods(settings);
    if(initialized.changed)await writeAtomicFile(this.file,JSON.stringify(initialized.settings,null,2),bytes?createHash('sha256').update(bytes).digest('hex'):'missing');
    return initialized.settings;
  }
  read(): Promise<Settings> {
    const task=this.pending.then(()=>this.readCurrent());this.pending=task.catch(()=>{});return task;
  }
  // Environment transactions merge only their game and reject an external edit before publication.
  saveGamePathsIfCurrent(game:GameId,expected:GamePaths,next:GamePaths):Promise<Settings>{
    const task=this.pending.then(async()=>{
      await assertNoLinks(this.file);let bytes:Buffer|undefined;
      try{bytes=await fs.readFile(this.file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const latest=bytes?validateSettings(JSON.parse(bytes.toString('utf8'))):defaultSettings(this.installDirectory);
      if(!Object.hasOwn(GAMES,game)||(['xxmiRoot','gameDirectory','modsDirectory']as const).some(key=>latest.games[game][key]!==expected[key]))throw new Error('游戏路径在提交期间变化，请重新检查。');
      const {settings,changed}=await this.withDefaultMods(mergeGamePaths(latest,game,next));if(!changed&&(['xxmiRoot','gameDirectory','modsDirectory']as const).every(key=>latest.games[game][key]===settings.games[game][key]))return latest;
      const digest=bytes?createHash('sha256').update(bytes).digest('hex'):'missing';
      await writeAtomicFile(this.file,JSON.stringify(settings,null,2),digest);return settings;
    });
    this.pending=task.catch(()=>{});return task;
  }
  save(input: unknown): Promise<Settings> {
    const settings = validateSettings(input);
    const task = this.pending.then(async () => {
      await this.withDefaultMods(settings);
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await writeAtomicJson(this.file,JSON.stringify(settings,null,2));
      return settings;
    });
    this.pending = task.catch(() => {});
    return task;
  }
}
