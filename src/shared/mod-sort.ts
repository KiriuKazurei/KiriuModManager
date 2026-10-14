import type {ModEntry} from './contracts';
export const SORT_FIELDS=['name','importedAt','state','favorite','character','category'] as const;
export type SortField=typeof SORT_FIELDS[number];
export interface SortCriterion {field:SortField;direction:'asc'|'desc'}
export const DEFAULT_SORT:SortCriterion[]=[{field:'name',direction:'asc'}];
export function readSort(value:unknown):SortCriterion[]{
 if(!Array.isArray(value)||!value.length||value.length>3)return DEFAULT_SORT;
 const seen=new Set<string>();for(const item of value){if(!item||!SORT_FIELDS.includes(item.field)||!['asc','desc'].includes(item.direction)||seen.has(item.field))return DEFAULT_SORT;seen.add(item.field);}return value;
}
const collator=new Intl.Collator('zh-CN');
export function sortMods(mods:readonly ModEntry[],criteria:SortCriterion[]):ModEntry[]{
 const fields=readSort(criteria);const keyed=mods.map(mod=>({mod,name:mod.name,path:mod.relativePath.replace(/\\/g,'/').toLocaleLowerCase(),importedAt:Date.parse(mod.provenance.importedAt),state:mod.disabledAncestors.length?2:mod.ownDisabled?1:0}));
 const text=(a:string,b:string,dir:number)=>!a||!b?(!a&&!b?0:!a?1:-1):collator.compare(a,b)*dir;
 keyed.sort((a,b)=>{for(const {field,direction} of fields){const dir=direction==='asc'?1:-1;let delta=0;
  if(field==='importedAt')delta=!Number.isFinite(a.importedAt)||!Number.isFinite(b.importedAt)?(!Number.isFinite(a.importedAt)&&!Number.isFinite(b.importedAt)?0:!Number.isFinite(a.importedAt)?1:-1):(a.importedAt-b.importedAt)*dir;
  else if(field==='state')delta=(a.state-b.state)*dir;
  else if(field==='favorite')delta=(Number(!!a.mod.favorite)-Number(!!b.mod.favorite))*dir;
  else delta=text(field==='name'?a.name:a.mod.metadata[field],field==='name'?b.name:b.mod.metadata[field],dir);
  if(delta)return delta;
 }return collator.compare(a.name,b.name)||collator.compare(a.path,b.path)||a.mod.id.localeCompare(b.mod.id);});return keyed.map(item=>item.mod);
}
