import type {ModProvenanceFields} from '../shared/contracts';
import {provenanceFields} from '../shared/mod-provenance';
export interface ProvenanceDraft {identity:string;fields:ModProvenanceFields;baseline:ModProvenanceFields}
export function rebaseProvenanceDraft(state:ProvenanceDraft|undefined,identity:string,latest:ModProvenanceFields,submitted?:ModProvenanceFields):ProvenanceDraft {
 if(!state||state.identity!==identity)return {identity,fields:{...latest},baseline:{...latest}};
 const fields={...latest};
 for(const field of provenanceFields)if(state.fields[field]!==state.baseline[field]&&(!submitted||state.fields[field]!==submitted[field]))(fields as Record<string,string>)[field]=state.fields[field];
 return {identity,fields,baseline:{...latest}};
}
