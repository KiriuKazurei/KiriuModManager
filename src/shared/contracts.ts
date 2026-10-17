import type {EnvironmentRepairRequest,EnvironmentRepairPreview,EnvironmentRepairReceipt} from './environment';
import type {ImportSource,ImportChoice,ImportReceipt,ImportFilePage} from './import-workflows';
import type {InspectionJob,ReportOptions,DiagnosticExport,RestorePreview,CleanupPreview,CleanupJob,ConflictDetails,ManagedReference} from './inspections';
import type {PresetManifestMember,PresetCommitResult,ManifestChoice,PresetImportOptions,PresetImportReceipt} from './preset-workflows';
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
export interface ModConfigChange {relativePath:string;kind:'added'|'removed'|'changed'|'same'}
export interface ModDownloadInstallPlan {targetRoot:string;updateTarget?:ModUpdateTarget;updatePreview?:{name:string;relativePath:string;versionBefore:string;versionAfter:string;enabled:boolean;activeProfile:boolean};folders:string[];items:(ModInstallDestination&{name:string;character:string;configChanges?:ModConfigChange[]})[]}
export interface ModDownload {id:string;gameId:GameId;targetRoot:string;purpose?:'new-install'|'update';updateTarget?:ModUpdateTarget;fileName:string;title:string;character?:string;stage:'binding'|'downloading'|'verifying'|'ready'|'installing'|'waiting-directory'|'complete'|'partial'|'error'|'canceled'|'interrupted';receivedBytes:number;totalBytes:number;archiveReady:boolean;message:string;importedIds:string[];items:ModDownloadInstallItem[];createdAt:string;updatedAt:string}
export type ModDownloadAction='cancel'|'retry-download'|'retry-binding'|'retry-install'|'install-current'|'show-file';
export interface ModBrowserStatus {gameId:GameId;url:string;loading:boolean;canGoBack:boolean;canGoForward:boolean;error:string;externalUrl:string;downloads:ModDownload[]}
export interface GamePaths { xxmiRoot: string; gameDirectory: string; modsDirectory: string }
export interface DesktopPreferences { marketUrl:string; updateUrl:string; closeToTray:boolean; updateSourceUrl?:string }
export interface Settings { version: 1; selectedGame: GameId; games: Record<GameId, GamePaths>; desktop?:DesktopPreferences }
export interface DesktopStatus { trayAvailable:boolean; floatingVisible:boolean; version:string }
export interface DesktopLaunchResult {status:'submitted'|'unconfirmed';message:string}
export interface DesktopChange { gameId:GameId; settingsChanged:boolean }
export interface Inspection {
  gameId: GameId; importer: string; xxmiRoot: string; launcherPath: string; launcherExists: boolean;
  importerDirectory: string; importerExists: boolean; iniPath: string; iniExists: boolean; gameDirectory: string;
  modsDirectories: string[]; modsExist: boolean[]; installed: boolean; warnings: string[];
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code?:string; details?:DependencyPlan };
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
export interface ModRequirements {mods:{modId:string;minimumVersion?:string}[];components:{component:'launcher'|'xxmi'|'importer';minimumVersion:string}[];gameVersion?:string;origin:'manual'|'author-stated';note?:string}
export interface DependencyIssue {modId:string;message:string;severity:'block'|'warning'}
export interface DependencyRequest {states?:Record<string,boolean>;deleteId?:string}
export interface DependencyPlan {token:string;states:Record<string,boolean>;issues:DependencyIssue[];dependents:string[];versions:Record<'launcher'|'xxmi'|'importer',string|null>}
export interface DependencyConfirmation {token:string;acceptWarnings:boolean}
export interface ActiveProfile {presetId:string;revision:string;members:Record<string,boolean>;files:{modId:string;relativePath:string;digest:string}[]}
export interface ModEntry { id: string; name: string; relativePath: string; metadata: ModMetadata; provenance:ModProvenance; remote?:ModRemoteInfo; favorite?:boolean; tags?:string[]; contentRevision?:string; requirements?:ModRequirements; enabled: boolean; ownDisabled: boolean; disabledAncestors: string[]; hasCover: boolean; iniCount: number }
export interface LibrarySnapshot { gameId: GameId; root: string; mods: ModEntry[]; exclusiveGroups:ExclusiveGroup[]; warnings: string[]; characters: string[]; categories: string[]; appearances: string[]; loaderMatched: boolean; excludeMatched: boolean }
export type ModOperation = { kind: 'toggle'; enabled: boolean } | { kind: 'rename'; name: string } | { kind: 'classify'; category: string; character: string; appearance: string } | { kind: 'metadata'; metadata: ModMetadata } | {kind:'provenance';fields:ModProvenanceFields} | {kind:'favorite';value:boolean} | {kind:'tags';values:string[]} | {kind:'requirements';value:ModRequirements};
export type BatchModOperation=Extract<ModOperation,{kind:'toggle'|'classify'}>;
export interface BatchModItem {id:string;name:string;ok:boolean;error?:string;message?:string}
export interface BatchModResult {library:LibrarySnapshot;items:BatchModItem[];conflicts:ExclusiveConflict[]}
export interface ImportResult { library: LibrarySnapshot; importedIds: string[]; errors: string[]; canceled: boolean }
export interface Preset { id:string; name:string; members:Record<string,boolean>; updatedAt:string; mode?:'states'|'profile';profileRef?:{revision:string};missingMods?:PresetManifestMember[] }
export interface ProfileScope {modId:string;relativePath:string}
export interface ProfileStatus {active?:ActiveProfile;dirty:boolean;issues:string[];files:(ProfileScope&{sourceRevision:string;digest:string})[]}
export interface ProfileApplyPlan {token:string;presetId:string;dirty:boolean;strategy:'backup'|'save';issues:string[];dependency:DependencyPlan;files:ProfileScope[]}
export interface ModUpdateCandidate {id:string;remote:ModRemoteInfo;version:string}
export interface ModUpdateCheck {modId:string;status:'current'|'options'|'newer'|'changed'|'manual'|'error';message:string;candidates:ModUpdateCandidate[]}
export interface ModUpdateTarget {modId:string;contentRevision:string;candidateVersion:string;root?:string;candidateFingerprint?:string}
export interface PresetApplyResult { library:LibrarySnapshot; issues:string[]; applied:number; conflicts:ExclusiveConflict[] }
export interface IniKey { section:string; line:number; key:string; back:string; keyLine?:number; backLine?:number }
export interface IniDocument { relativePath:string; text:string; encoding:string; newline:string; digest:string; keys:IniKey[] }
export type IniEdit = {kind:'text';text:string} | {kind:'keys';keys:IniKey[]};
export interface HashLocation { modId:string;modName:string;relativePath:string;line:number }
export interface ConflictReport { candidates:{hash:string;locations:HashLocation[]}[]; warnings:string[]; scannedMods:number }
export interface RecoveryItem { id:string;gameId:GameId;root:string;kind:'mod-delete'|'mod-replace'|'ini'|'snapshot'|'legacy'|'interrupted';name:string;createdAt:string;relativePath?:string;includesContent:boolean;manualLocation?:string }
export interface AppUpdateRelease { version:string; notes:string; publishedAt:string; url:string; sha256:string; size:number }
export interface AppUpdateStatus {
  stage:'idle'|'checking'|'available'|'current'|'downloading'|'verifying'|'ready'|'installing'|'error';
  currentVersion:string; release?:AppUpdateRelease; percent:number; message:string; canInstall:boolean;
  lastResult?:{stage:string;message:string;backup?:string};
}
export interface DesktopAPI {
  logReport(game:GameId):Promise<Result<import('./logging').LogReport>>;
  openLogDirectory():Promise<Result<void>>;
  reportRendererEvent(event:import('./logging').RendererLogEvent):Promise<Result<void>>;
  compatibilityStatus(game:GameId):Promise<Result<import('./compatibility').CompatibilityStatus>>;
  importCompatibilityEvidence(game:GameId):Promise<Result<import('./compatibility').CompatibilityStatus|null>>;
  checkGameEnvironment(game:GameId,mode:'quick'|'discover'):Promise<Result<InspectionJob>>;
  chooseGameInstallation(game:GameId,kind:'game'|'loader'):Promise<Result<InspectionJob|null>>;
  prepareEnvironmentRepair(game:GameId,request:EnvironmentRepairRequest):Promise<Result<EnvironmentRepairPreview>>;
  applyEnvironmentRepair(game:GameId,token:string):Promise<Result<EnvironmentRepairReceipt|null>>;
  prepareModImport(game:GameId,source:ImportSource):Promise<Result<InspectionJob|null>>;
  reviseModImport(game:GameId,sessionId:string,choices:ImportChoice[]):Promise<Result<InspectionJob>>;
  modImportFiles(game:GameId,sessionId:string,entryId:string,offset?:number):Promise<Result<ImportFilePage>>;
  commitModImport(game:GameId,token:string,acceptIncomplete:boolean):Promise<Result<ImportReceipt|null>>;
  discardModImport(game:GameId,sessionId:string):Promise<Result<void>>;
  preparePresetApply(game:GameId,id:string,choices?:ExclusiveChoices,excludedIds?:string[]):Promise<Result<InspectionJob>>;
  commitPresetApply(game:GameId,token:string,confirmation?:DependencyConfirmation):Promise<Result<PresetCommitResult|null>>;
  preparePresetExport(game:GameId,id:string,includeProfile:boolean):Promise<Result<InspectionJob>>;
  exportPresetManifest(game:GameId,token:string):Promise<Result<string|null>>;
  preparePresetManifestImport(game:GameId,draftId?:string):Promise<Result<InspectionJob|null>>;
  revisePresetManifestImport(game:GameId,sessionId:string,choices:ManifestChoice[]):Promise<Result<InspectionJob>>;
  commitPresetManifestImport(game:GameId,token:string,options:PresetImportOptions):Promise<Result<PresetImportReceipt>>;
  importPresetReplacement(game:GameId,sessionId:string,kind:'folder'|'archive'):Promise<Result<ImportResult>>;
  startDiagnostics(game:GameId):Promise<Result<InspectionJob>>;
  startRecoveryInventory(game:GameId):Promise<Result<InspectionJob>>;
  startConflictInspection(game:GameId):Promise<Result<InspectionJob>>;
  readInspectionJob(id:string):Promise<Result<InspectionJob>>;
  cancelInspectionJob(id:string):Promise<Result<InspectionJob>>;
  previewDiagnosticExport(id:string,options:ReportOptions):Promise<Result<DiagnosticExport>>;
  exportDiagnosticReport(id:string,format:'markdown'|'json',options:ReportOptions):Promise<Result<string|null>>;
  setRecoveryProtection(game:GameId,ids:string[],value:boolean):Promise<Result<Record<string,boolean>>>;
  prepareRecoveryRestore(game:GameId,id:string):Promise<Result<InspectionJob>>;
  applyRecoveryRestore(game:GameId,token:string,confirmation?:DependencyConfirmation):Promise<Result<LibrarySnapshot|null>>;
  prepareRecoveryCleanup(game:GameId,ids:string[]):Promise<Result<CleanupPreview>>;
  applyRecoveryCleanup(game:GameId,token:string):Promise<Result<CleanupJob|null>>;
  manageRecoveryCleanup(game:GameId,id:string,action:'read'|'continue'|'undo'|'cancel'):Promise<Result<CleanupJob|null>>;
  conflictDetails(game:GameId,resultId:string,groupId:string,offset?:number):Promise<Result<ConflictDetails>>;
  revealManagedLocation(game:GameId,reference:ManagedReference):Promise<Result<void>>;
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
  operateMod(game: GameId, id: string, operation: ModOperation,confirmation?:DependencyConfirmation): Promise<Result<LibrarySnapshot>>;
  dependencyCheck(game:GameId,request:DependencyRequest):Promise<Result<DependencyPlan>>;
  batchMods(game:GameId,ids:string[],operation:BatchModOperation,choices?:ExclusiveChoices,confirmation?:DependencyConfirmation):Promise<Result<BatchModResult>>;
  saveExclusiveGroup(game:GameId,id:string|null,name:string,modIds:string[],enabledId?:string,confirmation?:DependencyConfirmation):Promise<Result<LibrarySnapshot>>;
  deleteExclusiveGroup(game:GameId,id:string):Promise<Result<LibrarySnapshot>>;
  openModSource(game:GameId,id:string):Promise<Result<string>>;
  importMods(game: GameId, kind: 'folder' | 'archive'): Promise<Result<ImportResult>>;
  replaceMod(game: GameId, id: string, kind: 'folder' | 'archive',confirmation?:DependencyConfirmation): Promise<Result<LibrarySnapshot | null>>;
  deleteMod(game: GameId, id: string,confirmation?:DependencyConfirmation): Promise<Result<LibrarySnapshot | null>>;
  cover(game: GameId, id: string): Promise<Result<string | null>>;
  characterCovers(game:GameId):Promise<Result<Record<string,string>>>;
  chooseCharacterCover(game:GameId,name:string):Promise<Result<LibrarySnapshot|null>>;
  chooseCover(game: GameId, id: string): Promise<Result<LibrarySnapshot | null>>;
  addGroup(game: GameId, kind: 'category' | 'character' | 'appearance', name: string): Promise<Result<LibrarySnapshot>>;
  presets(game:GameId):Promise<Result<Preset[]>>;
  savePreset(game:GameId,id:string|null,name:string,members:Record<string,boolean>|null):Promise<Result<Preset[]>>;
  addModsToPreset(game:GameId,id:string,modIds:string[]):Promise<Result<Preset[]>>;
  deletePreset(game:GameId,id:string):Promise<Result<Preset[]>>;
  applyPreset(game:GameId,id:string,choices?:ExclusiveChoices,confirmation?:DependencyConfirmation):Promise<Result<PresetApplyResult>>;
  profileScope(game:GameId,id:string|null):Promise<Result<ProfileScope[]>>;
  profileCapture(game:GameId,id:string|null,name:string,scope:ProfileScope[]):Promise<Result<Preset[]>>;
  profileDuplicate(game:GameId,id:string,name:string):Promise<Result<Preset[]>>;
  profileStatus(game:GameId,id:string):Promise<Result<ProfileStatus>>;
  profilePrepareApply(game:GameId,id:string,choices?:ExclusiveChoices,strategy?:'backup'|'save'):Promise<Result<ProfileApplyPlan>>;
  profileApply(game:GameId,token:string,strategy:'backup'|'save'|'cancel',confirmation?:DependencyConfirmation):Promise<Result<LibrarySnapshot|null>>;
  readProfileIni(game:GameId,id:string,file:ProfileScope):Promise<Result<IniDocument>>;
  checkModUpdates(game:GameId,ids:string[]):Promise<Result<ModUpdateCheck[]>>;
  prepareModUpdate(game:GameId,id:string,candidateId:string):Promise<Result<ModBrowserStatus|null>>;
  iniFiles(game:GameId,id:string):Promise<Result<string[]>>;
  readIni(game:GameId,id:string,relativePath:string):Promise<Result<IniDocument>>;
  saveIni(game:GameId,id:string,relativePath:string,digest:string,edit:IniEdit):Promise<Result<IniDocument>>;
  conflicts(game:GameId):Promise<Result<ConflictReport>>;
  recovery(game:GameId):Promise<Result<RecoveryItem[]>>;
  createBackup(game:GameId,name:string):Promise<Result<RecoveryItem[]>>;
  restore(game:GameId,id:string,confirmation?:DependencyConfirmation):Promise<Result<LibrarySnapshot|null>>;
  desktopStatus():Promise<Result<DesktopStatus>>;
  floating(visible:boolean):Promise<Result<void>>;
  showMain():Promise<Result<void>>;
  quit():Promise<Result<void>>;
  selectGame(game:GameId):Promise<Result<Settings>>;
  launchXXMI(game:GameId,mode:'gui'|'game'):Promise<Result<DesktopLaunchResult>>;
  refreshGame(game:GameId):Promise<Result<string>>;
  openLink(game:GameId,kind:'market'|'update'):Promise<Result<string>>;
  onDesktopChange(callback:(event:DesktopChange)=>void):()=>void;
}
