import type {ProcessCheckStatus} from '../../../src/shared/compatibility';
export interface ProcessAttempt {status:ProcessCheckStatus;controlPassed:boolean;message:string}
/** A timeout alone is not a defect: require two same-context, controlled failures. */
export function processCaseVerdict(attempts:ProcessAttempt[]):ProcessCheckStatus{
 if(attempts.length===1&&attempts[0].status==='passed')return 'passed';
 if(attempts.length===2&&attempts.every(a=>a.status==='failed'&&a.controlPassed))return 'failed';
 return 'inconclusive';
}
