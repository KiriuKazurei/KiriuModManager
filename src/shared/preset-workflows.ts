import type {GameId,DependencyPlan,ExclusiveConflict,LibrarySnapshot} from './contracts';

export interface ModTreeHash {algorithm:'mod-tree-v1';sha256:string;files:number;bytes:number;structure:string}
export interface PresetManifestMember {
 key:string;id:string;name:string;enabled:boolean;version:string;
 source?:{provider:'gamebanana';modId:number;fileId:number;entryPath:string;downloadUrl:string;sourceUrl:string};
 hash:ModTreeHash;
}
export interface PortableProfileFile {key:string;relativePath:string;sha256:string}
export interface PortablePreset {
 format:'kmm-preset';schemaVersion:1;gameId:GameId;name:string;members:PresetManifestMember[];
 profile?:{files:PortableProfileFile[];compatible:Record<string,string>};
}
export interface PresetApplyRow {id:string;name:string;current:boolean|null;desired:boolean|null;outside:boolean;status:'enable'|'disable'|'unchanged'|'missing'|'excluded'|'blocked';message:string}
export interface PresetApplyPreview {
 kind:'preset-preview';token:string;gameId:GameId;presetId:string;name:string;root:string;expiresAt:string;
 rows:PresetApplyRow[];conflicts:ExclusiveConflict[];dependency:DependencyPlan;blockers:string[];canApply:boolean;changes:number;
}
export interface PresetCommitResult {library:LibrarySnapshot;applied:number;unchanged:number;excluded:string[]}
export interface PresetExportPreview {kind:'preset-export';token:string;name:string;manifest:PortablePreset;iniFiles:number;iniBytes:number;expiresAt:string}
export interface ManifestChoice {key:string;modId:string|null;acceptDifferentHash:boolean}
export interface ManifestMatch {member:PresetManifestMember;modId:string|null;basis:'hash'|'site'|'manual'|'missing';hashMatches:boolean|null;accepted:boolean;message:string}
export interface PresetImportPreview {
 kind:'preset-import';token:string;sessionId:string;gameId:GameId;name:string;matches:ManifestMatch[];
 candidates:{id:string;name:string;relativePath:string}[];warnings:string[];missing:string[];canImportProfile:boolean;hasProfile:boolean;expiresAt:string;
}
export interface PresetImportOptions {name:string;allowMissing:boolean;includeProfile:boolean}
export interface PresetImportReceipt {presetId:string;name:string;matched:number;missing:string[];replacements:{name:string;replacement:string}[];profileImported:boolean}
