export const GAMES = {
  zzz: { name: '绝区零', importer: 'ZZMI', subtitle: 'Zenless Zone Zero' },
  endfield: { name: '终末地', importer: 'EFMI', subtitle: 'Arknights: Endfield' },
} as const;
export type GameId = keyof typeof GAMES;
export const DEFAULT_APP_UPDATE_SOURCE='https://github.com/KiriuKazurei/KiriuModManager';
export const MOD_MARKET_URLS:Partial<Record<GameId,string>>={zzz:'https://gamebanana.com/games/19567',endfield:'https://gamebanana.com/games/21842'};
export interface ModRemoteInfo {provider:'gamebanana';modId:number;fileId:number;title:string;author:string;category:string;description:string;fileName:string;downloadUrl:string;size:number;checksum:string;checksumAlgorithm:'md5'|'';entryPath?:string}
export interface ModBrowserBounds {x:number;y:number;width:number;height:number}
export interface ModDownloadInstallItem {id?:string;name:string;ok:boolean;existing?:boolean;error?:string}
export interface ModInstallDestination {entryPath:string;folder:string}
export interface ModDownloadInstallPlan {targetRoot:string;folders:string[];items:(ModInstallDestination&{name:string;character:string})[]}
export interface ModDownload {id:string;gameId:GameId;targetRoot:string;fileName:string;title:string;character?:string;stage:'binding'|'downloading'|'verifying'|'ready'|'installing'|'waiting-directory'|'complete'|'partial'|'error'|'canceled'|'interrupted';receivedBytes:number;totalBytes:number;archiveReady:boolean;message:string;importedIds:string[];items:ModDownloadInstallItem[];createdAt:string;updatedAt:string}
export type ModDownloadAction='cancel'|'retry-download'|'retry-binding'|'retry-install'|'install-current'|'show-file';
export interface ModBrowserStatus {gameId:GameId;url:string;loading:boolean;canGoBack:boolean;canGoForward:boolean;error:string;externalUrl:string;downloads:ModDownload[]}
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
export interface ModProvenanceFields {sourceUrl:string;version:string;gameVersion:string;verification:'unverified'|'verified'|'broken'}
export interface ModVersionHistory extends ModProvenanceFields {changedAt:string;reason:'edited'|'replaced'}
export interface ModProvenance extends ModProvenanceFields {importedAt:string;history:ModVersionHistory[]}
export interface ExclusiveGroup {id:string;name:string;modIds:string[]}
export interface ExclusiveConflict {groupId:string;name:string;candidateIds:string[]}
export type ExclusiveChoices=Record<string,string>;
export interface ModEntry { id: string; name: string; relativePath: string; metadata: ModMetadata; provenance:ModProvenance; remote?:ModRemoteInfo; enabled: boolean; ownDisabled: boolean; disabledAncestors: string[]; hasCover: boolean; iniCount: number }
export interface LibrarySnapshot { gameId: GameId; root: string; mods: ModEntry[]; exclusiveGroups:ExclusiveGroup[]; warnings: string[]; characters: string[]; categories: string[]; appearances: string[]; loaderMatched: boolean; excludeMatched: boolean }
export type ModOperation = { kind: 'toggle'; enabled: boolean } | { kind: 'rename'; name: string } | { kind: 'classify'; category: string; character: string; appearance: string } | { kind: 'metadata'; metadata: ModMetadata } | {kind:'provenance';fields:ModProvenanceFields};
export type BatchModOperation=Extract<ModOperation,{kind:'toggle'|'classify'}>;
export interface BatchModItem {id:string;name:string;ok:boolean;error?:string;message?:string}
export interface BatchModResult {library:LibrarySnapshot;items:BatchModItem[];conflicts:ExclusiveConflict[]}
export interface ImportResult { library: LibrarySnapshot; importedIds: string[]; errors: string[]; canceled: boolean }
export interface Preset { id:string; name:string; members:Record<string,boolean>; updatedAt:string }
export interface PresetApplyResult { library:LibrarySnapshot; issues:string[]; applied:number; conflicts:ExclusiveConflict[] }
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
  setWindowTheme(theme:'day'|'night'):Promise<Result<void>>;
  setModBrowser(game:GameId,bounds:ModBrowserBounds|null):Promise<Result<ModBrowserStatus>>;
  modBrowserStatus():Promise<Result<ModBrowserStatus>>;
  navigateModBrowser(action:'back'|'forward'|'reload'|'home'|'external'):Promise<Result<ModBrowserStatus>>;
  modDownloadAction(id:string,action:ModDownloadAction,destinations?:ModInstallDestination[]):Promise<Result<ModBrowserStatus>>;
  modDownloadInstallPlan(id:string):Promise<Result<ModDownloadInstallPlan>>;
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
  batchMods(game:GameId,ids:string[],operation:BatchModOperation,choices?:ExclusiveChoices):Promise<Result<BatchModResult>>;
  saveExclusiveGroup(game:GameId,id:string|null,name:string,modIds:string[],enabledId?:string):Promise<Result<LibrarySnapshot>>;
  deleteExclusiveGroup(game:GameId,id:string):Promise<Result<LibrarySnapshot>>;
  openModSource(game:GameId,id:string):Promise<Result<string>>;
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
  addModsToPreset(game:GameId,id:string,modIds:string[]):Promise<Result<Preset[]>>;
  deletePreset(game:GameId,id:string):Promise<Result<Preset[]>>;
  applyPreset(game:GameId,id:string,choices?:ExclusiveChoices):Promise<Result<PresetApplyResult>>;
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
