import type {GameId,GamePaths,RecoveryItem} from './contracts';
export type InspectionKind='diagnostics'|'inventory'|'conflicts'|'restore-preview';
export interface DiagnosticFact {key:string;group:string;status:'pass'|'warning'|'error'|'unknown'|'skipped';message:string;evidence:string[];navigation?:'settings'|'recovery'|'mods'|'presets'}
export interface DiagnosticReport {kind:'diagnostics';gameId:GameId;version:string;observedAt:string;facts:DiagnosticFact[];incomplete:boolean}
export interface RecoverySpaceItem extends RecoveryItem {bytes:number|null;files:number;complete:boolean;protected:boolean;systemProtection:string[];cleanable:boolean;category:string;integrity:string}
export interface CleanupItemResult {id:string;name:string;phase:'planned'|'moving'|'staged'|'deleting'|'deleted'|'restored'|'error';bytes:number;message:string}
export interface CleanupJob {id:string;gameId:GameId;phase:'prepared'|'working'|'pending'|'complete'|'undone';items:CleanupItemResult[];createdAt:string}
export interface RecoveryInventory {kind:'inventory';gameId:GameId;observedAt:string;items:RecoverySpaceItem[];other:{category:string;bytes:number|null;files:number;complete:boolean;reason:string}[];profileReferences:{source:string;presetId:string;revision:string}[];referencesComplete:boolean;cleanupJobs:CleanupJob[];warnings:string[];complete:boolean}
export interface ConflictOccurrence {modId:string;modName:string;contentRevision:string;fileRelativePath:string;rootRelativePath:string;digest:string;line:number;section:string;type:'texture'|'shader';hash:string;namespace:string[];conditions:string[];filters:string[];resources:string[];runs:string[];warnings:string[]}
export interface ConflictGroup {id:string;type:'texture'|'shader';hash:string;modIds:string[];occurrenceCount:number}
export interface ConflictInspection {kind:'conflicts';gameId:GameId;resultId:string;groups:ConflictGroup[];warnings:string[];scannedMods:number;scannedFiles:number;complete:boolean}
export interface ConflictDetails {group:ConflictGroup;occurrences:(ConflictOccurrence&{snippet:string})[];total:number;offset:number;warnings:string[]}
export interface IniNavigationTarget {gameId:GameId;modId:string;fileRelativePath:string;line:number;expectedDigest:string}
export interface InspectionJob {id:string;kind:InspectionKind;gameId:GameId;paths:GamePaths;stage:'running'|'complete'|'canceled'|'error';progress:string;observedAt:string;stale:boolean;warnings:string[];result?:DiagnosticReport|RecoveryInventory|ConflictInspection|{kind:'restore-preview';preview:RestorePreview}}
export interface ReportOptions {includeNames:boolean}
export interface DiagnosticExport {json:string;markdown:string;stale:boolean;truncated:number}
export interface RestorePreview {token:string;id:string;gameId:GameId;name:string;kind:RecoveryItem['kind'];root:string;expiresAt:string;scope:{role:string;path:string;action:string;files:number;bytes:number|null}[];affectedIds:string[];warnings:string[];changes:{path:string;change:'added'|'removed'|'changed'|'same'|'not-compared'}[];complete:boolean;estimatedBytes:number|null;space:{volume:string;available:number|null;required:number}[]}
export interface CleanupPreview {token:string;gameId:GameId;expiresAt:string;items:{id:string;name:string;kind:string;root:string;bytes:number;files:number}[];warnings:string[]}
export type ManagedReference={kind:'mod';id:string}|{kind:'recovery';id:string}|{kind:'storage';category:'profiles'|'pending-operations'|'recovery-cleanup'|'root-history'};
