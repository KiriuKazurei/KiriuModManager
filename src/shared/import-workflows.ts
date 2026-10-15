import type {GameId,ImportResult} from './contracts';
import type {ModTreeHash} from './preset-workflows';
export type ImportSource={kind:'folder'|'archive'}|{kind:'download';taskId:string};
export interface ImportChoice {entryId:string;selected:boolean;folder:string;name:string;allowDuplicate:boolean}
export interface ImportPreviewItem extends ImportChoice {
 source:string;entryPath:string;iniCount:number;bytes:number;files:number;hash:ModTreeHash;
 character:string;category:string;reason:string;compound:boolean;binding:boolean;
 duplicates:{id:string;name:string}[];related:{id:string;name:string}[];
 comparison:'complete'|'incomplete';blockers:string[];
}
export interface ImportPreview {
 kind:'mod-import';effect:'owned-cache';gameId:GameId;sessionId:string;token:string;root:string;expiresAt:string;
 downloadTaskId?:string;folders:string[];items:ImportPreviewItem[];warnings:string[];sourceErrors:string[];
 space:{location:'cache'|'target';available:number|null;required:number}[];canCommit:boolean;
}
export interface ImportReceipt extends ImportResult {
 sessionId:string;items:{entryId:string;id?:string;name:string;ok:boolean;existing?:boolean;state:'imported'|'existing'|'skipped'|'failed'|'interrupted';error?:string}[];
}
export interface ImportFilePage {files:{path:string;bytes:number}[];offset:number;total:number}
