import {FeedbackNotice} from './Notices';
import {useState} from 'react';
import type {GameId,Preset,LibrarySnapshot,ExclusiveChoices} from '../shared/contracts';
import {useInspectionJob,InspectionProgress} from './InspectionJob';
import {ExclusiveChoiceForm} from './ExclusiveChoiceForm';
import {VirtualList} from './VirtualList';
import {unwrap} from './ui';

export function PresetApplyPanel({gameId,preset,library,busy,dirty,onSave,onApplied,onBusy}:{gameId:GameId;preset:Preset;library:LibrarySnapshot;busy:boolean;dirty:boolean;onSave:()=>Promise<void>;onApplied:()=>Promise<void>;onBusy:(value:boolean)=>void}){
 const inspection=useInspectionJob(gameId),[choices,setChoices]=useState<ExclusiveChoices>({}),[excluded,setExcluded]=useState<string[]>([]),[accept,setAccept]=useState(false),[decision,setDecision]=useState(false),[edited,setEdited]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const plan=inspection.job?.result?.kind==='preset-preview'&&inspection.job.result.presetId===preset.id?inspection.job.result:null,reading=inspection.job?.stage==='running';
 const prepare=async(nextChoices=choices,nextExcluded=excluded)=>{setDecision(false);setAccept(false);setEdited(false);setError('');setMessage('');await inspection.start(()=>window.kmm.preparePresetApply(gameId,preset.id,nextChoices,nextExcluded));};
 async function apply(){if(!plan)return;onBusy(true);setError('');setMessage('');try{const result=unwrap(await window.kmm.commitPresetApply(gameId,plan.token,plan.dependency.issues.length?{token:plan.dependency.token,acceptWarnings:accept}:undefined));if(result){inspection.clear();await onApplied();setMessage(`预设已应用：${result.applied} 项目录变化，${result.unchanged} 项保持不变。`);}else setMessage('已取消应用，文件未变更。');}catch(e){setError((e as Error).message);}finally{onBusy(false);}}
 return <section className="preset-apply-panel detail-section" aria-label="预设应用预览"><h3>应用前预览</h3><p className="hint">查看实际启停、缺少的成员和预设外联动；确认前不修改目录或 INI。</p>
  <button disabled={busy||reading} onClick={()=>{setChoices({});setExcluded([]);if(dirty)setDecision(true);else void prepare({},[]);}}>预览应用预设</button>
  {decision&&<section className="card" aria-label="处理未保存预设编辑"><p>名称或成员还有未保存的修改，请选择本次预览的内容。</p><div className="tool-actions"><button disabled={busy} onClick={()=>void(async()=>{onBusy(true);try{await onSave();await prepare({},[]);}catch(e){setError((e as Error).message);}finally{onBusy(false);}})()}>保存编辑后预览</button><button onClick={()=>void prepare({},[])}>使用已保存预设</button><button onClick={()=>setDecision(false)}>取消预览</button></div></section>}
  <InspectionProgress job={inspection.job} error={inspection.error} onCancel={()=>void inspection.cancel()}/>
  {plan&&<div className="preset-preview-content"><p><strong>{plan.name}</strong> · 实际目录变化 {plan.changes} 项</p>
   {!!plan.conflicts.length&&<ExclusiveChoiceForm conflicts={plan.conflicts} library={library} busy={busy||!!reading} confirmLabel="更新预览" onConfirm={value=>{setChoices(value);void prepare(value);}} onCancel={()=>{inspection.clear();setChoices({});setMessage('已取消预览，文件未变更。');}}/>}
   <VirtualList items={plan.rows} rowHeight={116} className="preset-preview-rows" itemKey={row=>row.id+row.status+row.outside} render={row=><article className="preset-preview-row"><strong>{row.name}</strong><span>{{enable:'将启用',disable:'将停用',unchanged:'保持不变',missing:'缺少 Mod',excluded:'本次排除',blocked:'阻挡'}[row.status]}{row.outside?' · 预设外联动':''}</span><small>{row.message}</small>{['missing','excluded'].includes(row.status)&&!row.outside&&<label><input type="checkbox" checked={excluded.includes(row.id)} disabled={busy||reading} onChange={e=>{setExcluded(previous=>e.target.checked?[...previous,row.id]:previous.filter(id=>id!==row.id));setEdited(true);setAccept(false);}}/>本次排除 {row.name}</label>}</article>}/>
   {edited&&<button disabled={busy||reading} onClick={()=>void prepare()}>按所选重新预览</button>}
   {plan.blockers.map((item,index)=><p className="error" key={index}>{item}</p>)}
   {plan.dependency.issues.map((issue,index)=><p key={index} className={issue.severity==='block'?'error':'mismatch'}>{issue.message}</p>)}
   {!!plan.dependency.issues.length&&<label><input type="checkbox" checked={accept} disabled={busy||reading} onChange={e=>setAccept(e.target.checked)}/>接受本次版本提示及预设外联动停用</label>}
   <div className="tool-actions"><button className="primary" disabled={busy||reading||edited||!plan.canApply||inspection.job?.stale||!!plan.dependency.issues.length&&!accept} onClick={()=>void apply()}>确认应用预设</button><button disabled={busy} onClick={()=>{inspection.clear();setMessage('已取消预览，文件未变更。');}}>取消应用预览</button></div>
  </div>}<FeedbackNotice error={error}/><FeedbackNotice message={message}/>
 </section>;
}
