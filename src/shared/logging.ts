import type {GameId} from './contracts';
export type LogLevel='debug'|'info'|'warning'|'error'|'fatal';
export interface RendererLogEvent {kind:'action'|'navigation'|'error'|'unhandled-rejection'|'react-error';control?:string;page?:string;gameId?:GameId;message?:string;stack?:string}
export interface LogEvidence {time:string;level:LogLevel;event:string;sessionId:string;operationId?:string;parentOperationId?:string;referenceIds?:string[];action?:string;gameId?:GameId;message?:string;code?:string}
export interface LogFinding {kind:string;level:'warning'|'error';title:string;count:number;explanation:string;evidence:LogEvidence[]}
export interface LogReport {directory:string;defaultDirectory:string;fallback:boolean;writable:boolean;writeFailures:number;sessionId:string;analyzedAt:string;files:number;records:number;malformedLines:number;truncated:boolean;findings:LogFinding[];recent:LogEvidence[]}
