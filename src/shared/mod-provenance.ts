import type {ModProvenance,ModProvenanceFields} from './contracts';
export const provenanceFields=['sourceUrl','version','gameVersion','verification'] as const;
export function emptyProvenance(importedAt=''):ModProvenance {return {sourceUrl:'',version:'',gameVersion:'',verification:'unverified',importedAt,history:[]};}
export function editableProvenance(value:ModProvenanceFields):ModProvenanceFields {const {sourceUrl,version,gameVersion,verification}=value;return {sourceUrl,version,gameVersion,verification};}
