export const GAMES = {
  zzz: { name: '绝区零', importer: 'ZZMI', subtitle: 'Zenless Zone Zero' },
  endfield: { name: '终末地', importer: 'EFMI', subtitle: 'Arknights: Endfield' },
} as const;
export type GameId = keyof typeof GAMES;
export const DEFAULT_APP_UPDATE_SOURCE='https://github.com/KiriuKazurei/KiriuModManager';
export interface GamePaths { xxmiRoot: string; gameDirectory: string; modsDirectory: string }
export interface DesktopPreferences { marketUrl:string; updateUrl:string; closeToTray:boolean; updateSourceUrl?:string }
export interface Settings { version: 1; selectedGame: GameId; games: Record<GameId, GamePaths>; desktop?:DesktopPreferences }
export interface DesktopStatus { trayAvailable:boolean; floatingVisible:boolean; version:string }
export interface DesktopChange { gameId:GameId; settingsChanged:boolean }
export interface Inspection {
  gameId: GameId; importer: string; xxmiRoot: string; launcherPath: string; launcherExists: boolean;
  importerDirectory: string; importerExists: boolean; iniPath: string; gameDirectory: string;
  modsDirectories: string[]; modsExist: boolean[]; installed: boolean; warnings: string[];
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface RuntimeStatus { installed: boolean; message: string; downloadUrl: string }
export interface DeploymentProgress { stage: 'idle' | 'resolve' | 'download' | 'verify' | 'extract' | 'configure' | 'complete' | 'error'; message: string; percent: number; bytes?: number; totalBytes?: number }
export interface DeploymentResult { settings: Settings; inspection: Inspection; versions: Record<string, string>; runtime: RuntimeStatus; filesDeployed: boolean; ready: boolean; backupDirectory?: string }
export interface SyncResult { settings: Settings; inspection: Inspection; backupDirectory: string }
export interface ModMetadata { category: string; character: string; appearance: string; author: string; description: string }
export interface ModEntry { id: string; name: string; relativePath: string; metadata: ModMetadata; enabled: boolean; ownDisabled: boolean; disabledAncestors: string[]; hasCover: boolean; iniCount: number }
export interface LibrarySnapshot { gameId: GameId; root: string; mods: ModEntry[]; warnings: string[]; characters: string[]; categories: string[]; appearances: string[]; loaderMatched: boolean; excludeMatched: boolean }
export type ModOperation = { kind: 'toggle'; enabled: boolean } | { kind: 'rename'; name: string } | { kind: 'classify'; category: string; character: string; appearance: string } | { kind: 'metadata'; metadata: ModMetadata };
export interface ImportResult { library: LibrarySnapshot; importedIds: string[]; errors: string[]; canceled: boolean }
export interface Preset { id:string; name:string; members:Record<string,boolean>; updatedAt:string }
export interface PresetApplyResult { library:LibrarySnapshot; issues:string[]; applied:number }
export interface IniKey { section:string; line:number; key:string; back:string; keyLine?:number; backLine?:number }
export interface IniDocument { relativePath:string; text:string; encoding:string; newline:string; digest:string; keys:IniKey[] }
export type IniEdit = {kind:'text';text:string} | {kind:'keys';keys:IniKey[]};
export interface HashLocation { modId:string;modName:string;relativePath:string;line:number }
export interface ConflictReport { candidates:{hash:string;locations:HashLocation[]}[]; warnings:string[]; scannedMods:number }
export interface RecoveryItem { id:string;gameId:GameId;root:string;kind:'mod-delete'|'mod-replace'|'ini'|'snapshot'|'legacy';name:string;createdAt:string;relativePath?:string;includesContent:boolean;manualLocation?:string }
export interface AppUpdateRelease { version:string; notes:string; publishedAt:string; url:string; sha256:string; size:number }
export interface AppUpdateStatus {
  stage:'idle'|'checking'|'available'|'current'|'downloading'|'verifying'|'ready'|'installing'|'error';
  currentVersion:string; release?:AppUpdateRelease; percent:number; message:string; canInstall:boolean;
  lastResult?:{stage:string;message:string;backup?:string};
}
export interface DesktopAPI {
  checkAppUpdate():Promise<Result<AppUpdateStatus>>;
  appUpdateStatus():Promise<Result<AppUpdateStatus>>;
  downloadAppUpdate():Promise<Result<AppUpdateStatus|null>>;
  installAppUpdate():Promise<Result<AppUpdateStatus|null>>;
  readSettings(): Promise<Result<Settings>>;
  saveSettings(settings: Settings): Promise<Result<Settings>>;
  saveGamePaths(game: GameId, patch: Partial<GamePaths>): Promise<Result<Settings>>;
  saveDesktopPreferences(patch: Partial<DesktopPreferences>): Promise<Result<Settings>>;
  chooseDirectory(current: string): Promise<Result<string | null>>;
  inspect(game: GameId, root: string): Promise<Result<Inspection>>;
  deploy(settings: Settings): Promise<Result<DeploymentResult>>;
  deploymentProgress(): Promise<Result<DeploymentProgress>>;
  syncPaths(settings: Settings): Promise<Result<SyncResult>>;
  checkRuntime(): Promise<Result<RuntimeStatus>>;
  openRuntimeDownload(): Promise<Result<void>>;
  scanMods(game: GameId): Promise<Result<LibrarySnapshot>>;
  operateMod(game: GameId, id: string, operation: ModOperation): Promise<Result<LibrarySnapshot>>;
  importMods(game: GameId, kind: 'folder' | 'archive'): Promise<Result<ImportResult>>;
  replaceMod(game: GameId, id: string, kind: 'folder' | 'archive'): Promise<Result<LibrarySnapshot | null>>;
  deleteMod(game: GameId, id: string): Promise<Result<LibrarySnapshot | null>>;
  cover(game: GameId, id: string): Promise<Result<string | null>>;
  characterCovers(game:GameId):Promise<Result<Record<string,string>>>;
  chooseCharacterCover(game:GameId,name:string):Promise<Result<LibrarySnapshot|null>>;
  chooseCover(game: GameId, id: string): Promise<Result<LibrarySnapshot | null>>;
  addGroup(game: GameId, kind: 'category' | 'character' | 'appearance', name: string): Promise<Result<LibrarySnapshot>>;
  presets(game:GameId):Promise<Result<Preset[]>>;
  savePreset(game:GameId,id:string|null,name:string,members:Record<string,boolean>|null):Promise<Result<Preset[]>>;
  deletePreset(game:GameId,id:string):Promise<Result<Preset[]>>;
  applyPreset(game:GameId,id:string):Promise<Result<PresetApplyResult>>;
  iniFiles(game:GameId,id:string):Promise<Result<string[]>>;
  readIni(game:GameId,id:string,relativePath:string):Promise<Result<IniDocument>>;
  saveIni(game:GameId,id:string,relativePath:string,digest:string,edit:IniEdit):Promise<Result<IniDocument>>;
  conflicts(game:GameId):Promise<Result<ConflictReport>>;
  recovery(game:GameId):Promise<Result<RecoveryItem[]>>;
  createBackup(game:GameId,name:string):Promise<Result<RecoveryItem[]>>;
  restore(game:GameId,id:string):Promise<Result<LibrarySnapshot|null>>;
  desktopStatus():Promise<Result<DesktopStatus>>;
  floating(visible:boolean):Promise<Result<void>>;
  showMain():Promise<Result<void>>;
  quit():Promise<Result<void>>;
  selectGame(game:GameId):Promise<Result<Settings>>;
  launchXXMI(game:GameId,mode:'gui'|'game'):Promise<Result<string>>;
  refreshGame(game:GameId):Promise<Result<string>>;
  openLink(game:GameId,kind:'market'|'update'):Promise<Result<string>>;
  onDesktopChange(callback:(event:DesktopChange)=>void):()=>void;
}
