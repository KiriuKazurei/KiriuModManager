import type {GameId,ModEntry,ModMetadata} from '../shared/contracts';
type EditableMod=Pick<ModEntry,'id'|'name'|'metadata'>;
export type ModDraftCommit='rename'|'metadata'|'classify';
export interface ModDetailDraft {gameId:GameId;modId:string|null;name:string;metadata:ModMetadata;baseline:{name:string;metadata:ModMetadata}}
const emptyMetadata=():ModMetadata=>({category:'',character:'',appearance:'',author:'',description:''});
const fields:(keyof ModMetadata)[]=['category','character','appearance','author','description'];
export function rebaseModDraft(state:ModDetailDraft|undefined,gameId:GameId,mod?:EditableMod,committed?:ModDraftCommit):ModDetailDraft {
  const baseline={name:mod?.name||'',metadata:{...(mod?.metadata||emptyMetadata())}};
  if(!state||state.gameId!==gameId||state.modId!==(mod?.id||null)||!mod)return {gameId,modId:mod?.id||null,name:baseline.name,metadata:{...baseline.metadata},baseline};
  const metadata={...baseline.metadata};
  for(const field of fields){const saved=committed==='metadata'||committed==='classify'&&['category','character','appearance'].includes(field);if(!saved&&state.metadata[field]!==state.baseline.metadata[field])metadata[field]=state.metadata[field];}
  return {gameId,modId:mod.id,name:committed!=='rename'&&state.name!==state.baseline.name?state.name:mod.name,metadata,baseline};
}
