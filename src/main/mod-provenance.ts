import type {ModProvenance,ModProvenanceFields} from '../shared/contracts';
import {emptyProvenance,editableProvenance,provenanceFields} from '../shared/mod-provenance';
import {validateWebUrl} from './web-links';
export function validateProvenanceFields(input:unknown):ModProvenanceFields {
 const value=input as ModProvenanceFields;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!provenanceFields.includes(key as typeof provenanceFields[number])))throw new Error('来源与版本字段格式无效。');
 for(const field of ['version','gameVersion'] as const)if(typeof value[field]!=='string'||value[field].length>120||/[\r\n\0]/.test(value[field]))throw new Error('版本信息须为不超过 120 字符的单行文本。');
 if(!['unverified','verified','broken'].includes(value.verification))throw new Error('人工验证状态无效。');
 return {sourceUrl:validateWebUrl(value.sourceUrl),version:value.version.trim(),gameVersion:value.gameVersion.trim(),verification:value.verification};
}
export function readProvenance(input:ModProvenance|undefined):ModProvenance {
 if(!input)return emptyProvenance();
 const fields=validateProvenanceFields(editableProvenance(input));
 if(typeof input.importedAt!=='string'||input.importedAt&&!Number.isFinite(Date.parse(input.importedAt))||!Array.isArray(input.history))throw new Error('来源与版本记录格式无效。');
 const history=input.history.map(item=>{if(!item||!['edited','replaced'].includes(item.reason)||typeof item.changedAt!=='string'||!Number.isFinite(Date.parse(item.changedAt)))throw new Error('版本历史格式无效。');return {...validateProvenanceFields(editableProvenance(item)),reason:item.reason,changedAt:item.changedAt};});
 return {...fields,importedAt:input.importedAt,history};
}
export function updateProvenance(previous:ModProvenance|undefined,fields:ModProvenanceFields,reason:'edited'|'replaced'):ModProvenance {
 const old=readProvenance(previous);const next=validateProvenanceFields(fields);
 if(reason==='edited'&&provenanceFields.every(field=>old[field]===next[field]))return old;
 return {...next,importedAt:old.importedAt,history:[...old.history,{...editableProvenance(old),reason,changedAt:new Date().toISOString()}]};
}
