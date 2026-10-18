import type {ModEntry} from '../shared/contracts';
import {Icon} from './ui';
import {ModTagList} from './ModTags';

export function ModLibraryRow({mod,selected,checked,busy,onSelect,onCheck,onFavorite}:{mod:ModEntry;selected:boolean;checked:boolean;busy:boolean;onSelect:()=>void;onCheck:(checked:boolean)=>void;onFavorite:()=>void}){
 return <div className="mod-row-selection"><input type="checkbox" aria-label={`选择 ${mod.name}`} checked={checked} disabled={busy} onChange={event=>onCheck(event.target.checked)}/><button type="button" className="favorite-button" aria-label={`${mod.favorite?'取消收藏':'收藏'} ${mod.name}`} aria-pressed={!!mod.favorite} disabled={busy} onClick={onFavorite}><svg viewBox="0 0 24 24" width="18" height="18" fill={mod.favorite?'currentColor':'none'} stroke="currentColor" aria-hidden="true"><path d="m12 3 2.8 5.7 6.3.9-4.6 4.5 1.1 6.3-5.6-3-5.6 3 1.1-6.3L3 9.6l6.2-.9Z"/></svg></button>
  <div className="mod-row-main"><button type="button" className={`mod-row ${selected?'selected':''}`} aria-pressed={selected} aria-label={mod.name} onClick={onSelect}><div className="row-symbol"><Icon kind="folder"/></div><div className="row-content"><strong title={mod.name}>{mod.name}</strong><span>{[mod.metadata.character,mod.metadata.appearance].filter(Boolean).join(' · ')||'尚未分类'}</span><small>{mod.relativePath}</small></div></button><ModTagList mod={mod}/><span className={`mod-state ${mod.enabled?'enabled':''}`}>{mod.enabled?'启用':mod.disabledAncestors.length?'父目录停用':'停用'}</span></div>
 </div>;
}
