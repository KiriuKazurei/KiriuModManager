import {useRef} from 'react';
import type {SortCriterion} from '../shared/mod-sort';
import {ModSortControl} from './ModSortControl';

export function ModLibraryFilters({status,onStatus,favorites,onFavorites,availableTags,tagFilters,onTags,tagQuery,onTagQuery,sort,onSort}:{status:string;onStatus:(value:string)=>void;favorites:boolean;onFavorites:(value:boolean)=>void;availableTags:string[];tagFilters:string[];onTags:(value:string[])=>void;tagQuery:string;onTagQuery:(value:string)=>void;sort:SortCriterion[];onSort:(value:SortCriterion[])=>void}){
 const popup=useRef<HTMLDivElement>(null),visible=[...new Set([...tagFilters,...availableTags.filter(tag=>tag.toLocaleLowerCase().includes(tagQuery.toLocaleLowerCase())).slice(0,24)])];
 const count=Number(status!=='all')+Number(favorites)+tagFilters.length;
 return <div className="mod-library-filters"><button type="button" aria-label="筛选与排序" onClick={event=>{const node=popup.current;if(!node)return;if(node.matches(':popover-open')){node.hidePopover();return;}node.showPopover();const box=event.currentTarget.getBoundingClientRect(),bounds=node.getBoundingClientRect();node.style.left=Math.max(12,Math.min(box.right-bounds.width,innerWidth-bounds.width-12))+'px';node.style.top=Math.max(12,Math.min(box.bottom+8,innerHeight-bounds.height-12))+'px';}}>筛选{count>0?` (${count})`:''}</button>
  <div ref={popup} popover="auto" role="dialog" aria-label="筛选与排序" className="library-filter-popover"><h3>筛选与排序</h3><label>启停状态<select aria-label="启停筛选" value={status} onChange={event=>onStatus(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select></label><button type="button" aria-pressed={favorites} onClick={()=>onFavorites(!favorites)}>{favorites?'仅收藏':'全部 / 收藏'}</button>
   {availableTags.length>0&&<fieldset><legend>标签</legend>{availableTags.length>24&&<input aria-label="搜索筛选标签" placeholder="搜索标签" value={tagQuery} onChange={event=>onTagQuery(event.target.value)}/>}<div className="filter-tags">{visible.map(tag=><label key={tag}><input type="checkbox" checked={tagFilters.includes(tag)} onChange={event=>onTags(event.target.checked?[...tagFilters,tag]:tagFilters.filter(value=>value!==tag))}/>{tag}</label>)}</div></fieldset>}
   <ModSortControl value={sort} onChange={onSort}/><button type="button" onClick={()=>{onStatus('all');onFavorites(false);onTags([]);onTagQuery('');}}>清除筛选</button>
  </div>
 </div>;
}
