import type {GameId,GamePaths,Settings} from './contracts';
export type EnvironmentScope='save'|'sync-game'|'sync-mods';
export interface EnvironmentCandidate {id:string;kind:'game'|'loader'|'current';name:string;source:string;paths:GamePaths;executable:string}
export interface EnvironmentRepairRecord {id:string;gameId:GameId;phase:'prepared'|'working'|'complete'|'rolled-back'|'pending';createdAt:string;scope:EnvironmentScope;message:string}
export interface EnvironmentReport {
 kind:'environment';resultId:string;gameId:GameId;paths:GamePaths;observedAt:string;
 state:'healthy'|'change-detected'|'needs-selection'|'needs-component'|'transient'|'unavailable'|'unknown';
 loader:{installed:boolean;importer:string;importerDirectory:string;importerExists:boolean;gameDirectory:string;modsDirectories:string[]};candidates:EnvironmentCandidate[];issues:string[];complete:boolean;executable:string;
 capabilities:{manageMods:boolean;launch:boolean;refresh:boolean;sync:boolean};repairs:EnvironmentRepairRecord[];
}
export type EnvironmentRepairRequest={kind:'repair';resultId:string;candidateId:string;scope:EnvironmentScope}|{kind:'rollback';repairId:string};
export interface EnvironmentRepairPreview {token:string;gameId:GameId;action:'repair'|'rollback';expiresAt:string;scope:EnvironmentScope;changes:{role:string;before:string;after:string}[];warnings:string[];repairId?:string}
export interface EnvironmentRepairReceipt {gameId:GameId;repair:EnvironmentRepairRecord;settings:Settings;warnings:string[]}
