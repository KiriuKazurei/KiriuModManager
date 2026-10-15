import {useState} from 'react';
import type {ExclusiveChoices,ExclusiveConflict,LibrarySnapshot} from '../shared/contracts';
export function ExclusiveChoiceForm({conflicts,library,busy,onConfirm,onCancel,confirmLabel='确认所选成员并执行'}:{conflicts:ExclusiveConflict[];library:LibrarySnapshot;busy:boolean;onConfirm:(choices:ExclusiveChoices)=>void;onCancel:()=>void;confirmLabel?:string}) {
 const [choices,setChoices]=useState<ExclusiveChoices>({});
 return <form className="exclusive-choice" aria-label="互斥成员选择" onSubmit={e=>{e.preventDefault();onConfirm(choices);}}>
  <p>同组有多个请求启用的成员。尚未执行任何操作，请为每组选择一个。</p>
  {conflicts.map(conflict=><label key={conflict.groupId}>{conflict.name}<select aria-label={`互斥组 ${conflict.name} 的启用成员`} disabled={busy} value={choices[conflict.groupId]||''} onChange={e=>setChoices(previous=>({...previous,[conflict.groupId]:e.target.value}))}><option value="">请选择一个成员</option>{conflict.candidateIds.map(id=><option key={id} value={id}>{library.mods.find(mod=>mod.id===id)?.name||id}</option>)}</select></label>)}
  <div className="tool-actions"><button className="primary" disabled={busy||conflicts.some(conflict=>!choices[conflict.groupId])}>{confirmLabel}</button><button type="button" disabled={busy} onClick={onCancel}>取消本次操作</button></div>
 </form>;
}
