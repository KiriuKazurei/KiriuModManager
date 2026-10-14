import {useMemo,useState} from 'react';
import {VirtualList} from './VirtualList';
import type {ExclusiveGroup,LibrarySnapshot} from '../shared/contracts';
import {unwrap,OperationFeedback,guarded} from './ui';
export function ExclusiveGroupsPanel({library,selectedIds,busy,onBusy,onUpdated}:{library:LibrarySnapshot;selectedIds:string[];busy:boolean;onBusy:(busy:boolean)=>void;onUpdated:(library:LibrarySnapshot)=>void}) {
 const [expanded,setExpanded]=useState(false);
 const modsById=useMemo(()=>new Map(library.mods.map(mod=>[mod.id,mod])),[library]);
 const [id,setId]=useState<string|null>(null);const [name,setName]=useState('');const [members,setMembers]=useState<string[]>([]);const [enabledId,setEnabledId]=useState('');const [error,setError]=useState('');const [message,setMessage]=useState('');
 const memberSet=useMemo(()=>new Set(members),[members]);
 function select(group?:ExclusiveGroup){setId(group?.id||null);setName(group?.name||'');setMembers(group?.modIds||[]);setEnabledId('');setError('');setMessage('');}
 async function action(work:()=>Promise<LibrarySnapshot>,message:string){onBusy(true);setError('');setMessage('');try{const next=await work();onUpdated(next);setMessage(message);}catch(e){setError((e as Error).message);}finally{onBusy(false);}}
 return <details className="exclusive-groups" onToggle={event=>setExpanded(event.currentTarget.open)}><summary>角色外观互斥组（{library.exclusiveGroups.length}）</summary>{expanded&&<><p className="mod-business-note">同组只保留一个启用成员。服装、配件是否互斥由你决定，每个 Mod 只能属于一个组。</p>
  <div className="exclusive-group-list">{library.exclusiveGroups.map(group=><button key={group.id} type="button" disabled={busy} aria-pressed={id===group.id} onClick={()=>select(group)}>{group.name} · {group.modIds.length}</button>)}</div>
  <div className="tool-actions"><button type="button" disabled={busy} onClick={()=>select()}>新建互斥组</button><button type="button" disabled={busy||selectedIds.length<2} onClick={()=>{select();setMembers([...selectedIds]);}}>以所选创建互斥组</button></div>
  <form onSubmit={e=>{e.preventDefault();void action(async()=>{const next=await guarded(c=>window.kmm.saveExclusiveGroup(library.gameId,id,name,members,enabledId||undefined,c));const group=id?next.exclusiveGroups.find(group=>group.id===id):next.exclusiveGroups.at(-1);if(group)select(group);return next;},'互斥组已保存。');}}>
   <label htmlFor="exclusive-group-name">互斥组名称</label><input id="exclusive-group-name" value={name} disabled={busy} onChange={e=>setName(e.target.value)}/>
   <fieldset className="exclusive-members"><legend>互斥组成员</legend><VirtualList items={library.mods} rowHeight={56} className="exclusive-member-list" itemKey={mod=>mod.id} render={mod=>{const elsewhere=library.exclusiveGroups.find(group=>group.id!==id&&group.modIds.includes(mod.id));return <label className="check-row" key={mod.id}><input type="checkbox" checked={memberSet.has(mod.id)} disabled={busy||!!elsewhere&&!members.includes(mod.id)} onChange={e=>{setMembers(previous=>e.target.checked?[...previous,mod.id]:previous.filter(id=>id!==mod.id));if(enabledId===mod.id)setEnabledId('');}}/><span>{mod.name}{elsewhere&&<small>已在 {elsewhere.name}</small>}</span></label>;}}/>{members.filter(id=>!modsById.has(id)).map(id=><label className="check-row" key={id}><input type="checkbox" checked disabled={busy} onChange={()=>setMembers(previous=>previous.filter(member=>member!==id))}/><span>缺失成员 · {id}</span></label>)}</fieldset>
   <label htmlFor="exclusive-enabled-member">保存时启用的成员</label><select id="exclusive-enabled-member" value={enabledId} disabled={busy} onChange={e=>setEnabledId(e.target.value)}><option value="">保留当前启停状态</option>{members.filter(id=>modsById.has(id)).map(id=><option key={id} value={id}>{modsById.get(id)?.name}</option>)}</select>
   <button disabled={busy||members.length<2||!name.trim()}>保存互斥组</button>{id&&<button type="button" disabled={busy} onClick={()=>void action(async()=>{const next=unwrap(await window.kmm.deleteExclusiveGroup(library.gameId,id));select();return next;},'互斥组已删除，成员文件及启停状态保持。')}>删除互斥组</button>}
  </form><OperationFeedback error={error} message={message} quiet="保存组不移动分类目录；选择启用成员时会停用同组其它成员。"/></>}
 </details>;
}
