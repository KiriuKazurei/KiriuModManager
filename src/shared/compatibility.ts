import type {GameId} from './contracts';
export type ProcessCheckStatus='passed'|'failed'|'inconclusive';
export interface CompatibilityTarget {fingerprint:string;gameBuild:string;components:Record<string,string>;managerBuild:string}
export interface ProcessCompatibilityEvidence {
 schemaVersion:1;kind:'kmm-process-compatibility';scope:'restart-recovery';gameId:GameId;
 managerVersion:string;sourceDigest:string;runId:string;testedAt:string;target:CompatibilityTarget;
 checks:{local:ProcessCheckStatus;restart:ProcessCheckStatus;recovery:ProcessCheckStatus};
 recoveryComplete:boolean;verdict:ProcessCheckStatus;digest:string;
}
export interface CompatibilityStatus {
 gameId:GameId;state:'unverified'|'passed'|'failed'|'inconclusive'|'stale'|'unknown';
 message:string;checkedAt:string;target?:CompatibilityTarget;evidence?:ProcessCompatibilityEvidence;
}
