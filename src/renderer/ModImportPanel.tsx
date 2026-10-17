import {useEffect,useRef,useState} from 'react';
import type {GameId} from '../shared/contracts';
import type {ImportSource,ImportChoice,ImportFilePage,ImportReceipt} from '../shared/import-workflows';
import {InspectionProgress,useInspectionJob} from './InspectionJob';
import {unwrap} from './ui';
import {showNotice} from './Notices';
const size=(n:number)=>n<1024**2?(n/1024).toFixed(1)+' KiB':(n/1024**2).toFixed(1)+' MiB';
export function ModImportPanel({gameId,source,onClose,onComplete,onBusy}:{gameId:GameId;source:ImportSource;onClose:()=>void;onComplete:(r:ImportReceipt)=>void;onBusy?:(busy:boolean)=>void}){
 const inspection=useInspectionJob(gameId),{job}=inspection,plan=job?.result?.kind==='mod-import'?job.result:null;
 const [choices,setChoices]=useState<ImportChoice[]>([]),[edited,setEdited]=useState(false),[accept,setAccept]=useState(false),[busy,setBusy]=useState(false),[receipt,setReceipt]=useState<ImportReceipt|null>(null);
 const [filePage,setFilePage]=useState<{entryId:string;page:ImportFilePage}|null>(null),started=useRef(false),session=useRef('');
 useEffect(()=>{if(!started.current){started.current=true;void inspection.start(()=>window.kmm.prepareModImport(gameId,source));}},[]);
 useEffect(()=>{if(plan){session.current=plan.sessionId;setChoices(plan.items.map(({entryId,selected,folder,name,allowDuplicate})=>({entryId,selected,folder,name,allowDuplicate})));setEdited(false);setAccept(false);setFilePage(null);}},[plan?.token]);
 useEffect(()=>()=>{if(session.current)void window.kmm.discardModImport(gameId,session.current);},[gameId]);
 function edit(entryId:string,patch:Partial<ImportChoice>){setChoices(rows=>rows.map(row=>row.entryId===entryId?{...row,...patch}:row));setEdited(true);}
 async function close(){if(busy){if(session.current)unwrap(await window.kmm.discardModImport(gameId,session.current));return;}const id=session.current;session.current='';inspection.clear();onClose();if(id)await window.kmm.discardModImport(gameId,id);}
 async function files(entryId:string,offset=0){try{if(!plan)return;setFilePage({entryId,page:unwrap(await window.kmm.modImportFiles(gameId,plan.sessionId,entryId,offset))});}catch(error){inspection.setError((error as Error).message);}}
 async function chooseFolder(entryId:string){if(!plan)return;try{const choice=choices.find(c=>c.entryId===entryId)!,chosen=unwrap(await window.kmm.chooseDirectory([plan.root,choice.folder].filter(Boolean).join('/')));if(!chosen)return;const root=plan.root.replaceAll('\\','/').replace(/\/+$/,''),folder=chosen.replaceAll('\\','/').replace(/\/+$/,'');if(folder.toLowerCase()!==root.toLowerCase()&&!folder.toLowerCase().startsWith(root.toLowerCase()+'/'))throw new Error('请选择当前 Mod 根目录内的角色／分类文件夹。');edit(entryId,{folder:folder.slice(root.length).replace(/^\//,'')});}catch(error){inspection.setError((error as Error).message);}}
 async function commit(){if(!plan)return;setBusy(true);onBusy?.(true);inspection.setError('');try{const result=unwrap(await window.kmm.commitModImport(gameId,plan.token,accept));if(result){setReceipt(result);const issues=[...new Set([...result.errors,...result.items.filter(item=>!item.ok&&item.error).map(item=>item.name+'：'+item.error)])];void showNotice({title:'导入结果',tone:issues.length?'warning':'success',message:`已导入 ${result.importedIds.length} 项，新 Mod 默认停用。详细结果保留在导入列表。`,detail:issues.join('\n').slice(0,60000)});onComplete(result);}}catch(error){inspection.setError((error as Error).message);}finally{setBusy(false);onBusy?.(false);}}
 const reading=job?.stage==='running',unknown=!!plan&&(plan.space.some(s=>s.available===null)||plan.items.some(i=>i.selected&&i.comparison==='incomplete'));
 return <section className="card mod-import-panel" aria-label="导入预检" data-preview-token={plan?.token} data-session-id={plan?.sessionId}>
  <div className="page-heading"><div><h2>导入预检</h2><p>选择条目与安装位置，确认后导入。新 Mod 默认停用；已有内容保持。</p></div><button onClick={()=>void close().catch(e=>inspection.setError(e.message))}>{busy?'停止剩余项':'关闭导入预检'}</button></div>
  <InspectionProgress job={job} error={inspection.error} onCancel={()=>void inspection.cancel()}/>
  {receipt?<div role="status" className="import-receipt"><strong>已导入 {receipt.importedIds.length} 项，默认停用。</strong><ul>{receipt.items.map(item=><li key={item.entryId} className={item.ok?'':'error'}>{item.name}：{{imported:'已导入',existing:'已有相同内容，保持',skipped:'已跳过',failed:'失败',interrupted:'未执行'}[item.state]}{item.error?' · '+item.error:''}</li>)}</ul>{receipt.errors.map(error=><p className="error" key={error}>{error}</p>)}</div>:plan&&<>
   <p><strong>目标根目录：</strong><code>{plan.root}</code></p><p className="hint">已创建本次准备缓存；还没有提交到 Mod 库。完全重复内容默认跳过，角色与目录建议可修改。</p>
   {plan.sourceErrors.map(error=><p className="error" key={error}>{error}</p>)}{plan.warnings.map(warning=><p className="mismatch" key={warning}>{warning}</p>)}
   <div className="import-items">{plan.items.map(item=>{const choice=choices.find(c=>c.entryId===item.entryId);if(!choice)return null;return <article className="import-item" key={item.entryId} data-entry-id={item.entryId}>
    <label className="check-row"><input type="checkbox" aria-label={'导入 '+item.name} checked={choice.selected} disabled={reading||busy} onChange={e=>edit(item.entryId,{selected:e.target.checked})}/><strong>{item.name}</strong></label>
    <p>{item.source} / {item.entryPath||'根条目'} · {item.iniCount} 个 INI · {item.files} 个文件 · {size(item.bytes)} · {item.binding?'网站绑定已核对':'本地来源'}</p>
    <p>{item.reason}{item.character?' · '+item.character:''}{item.compound?' · 包含根配置或共享资源，按整体保留':''}</p>
    <div className="import-fields"><label>安装名称<input aria-label={item.name+'安装名称'} value={choice.name} disabled={reading||busy} onChange={e=>edit(item.entryId,{name:e.target.value})}/></label><label>角色／分类目录<input aria-label={item.name+'安装目录'} value={choice.folder} list={'import-folders-'+plan.sessionId} disabled={reading||busy} placeholder="留空安装到 Mod 根目录" onChange={e=>edit(item.entryId,{folder:e.target.value})}/></label><button disabled={reading||busy} aria-label={item.name+'选择文件夹'} onClick={()=>void chooseFolder(item.entryId)}>选择文件夹</button></div>
    <small>目标：{[choice.folder,'DISABLED_'+choice.name].filter(Boolean).join('/')} · 安装后停用</small>
    <details><summary>内容摘要与文件清单</summary><code>SHA256：{item.hash.sha256}</code><p>{item.comparison==='complete'?'当前库内容比较已完成':'当前库比较未完成，不能认定没有重复'}</p><button disabled={reading||busy} onClick={()=>void files(item.entryId)}>查看文件清单</button></details>
    {!!item.duplicates.length&&<p>完全重复：{item.duplicates.map(m=>m.name).join('、')}</p>}{!!item.related.length&&<p>已有相同网站文件关联：{item.related.map(m=>m.name).join('、')}；内容一致性以摘要比较为准。</p>}
    {(item.duplicates.length>0||item.related.length>0)&&<label><input type="checkbox" aria-label={item.name+'仍另存副本'} checked={choice.allowDuplicate} disabled={reading||busy} onChange={e=>edit(item.entryId,{allowDuplicate:e.target.checked})}/>仍另存副本（已有项保持，需要不同的目标）</label>}
    {item.blockers.map(blocker=><p className={choice.selected?'error':'hint'} key={blocker}>{blocker}</p>)}
   </article>;})}</div><datalist id={'import-folders-'+plan.sessionId}>{plan.folders.map(folder=><option key={folder} value={folder}/>)}</datalist>
   {filePage&&<section className="import-file-page" aria-label="导入文件清单"><h3>文件清单 · {filePage.page.total} 项</h3><ul>{filePage.page.files.map(file=><li key={file.path}>{file.path} · {size(file.bytes)}</li>)}</ul><div className="tool-actions"><button disabled={filePage.page.offset===0} onClick={()=>void files(filePage.entryId,Math.max(0,filePage.page.offset-100))}>上一页</button><button disabled={filePage.page.offset+filePage.page.files.length>=filePage.page.total} onClick={()=>void files(filePage.entryId,filePage.page.offset+100)}>下一页</button><button onClick={()=>setFilePage(null)}>收起文件清单</button></div></section>}
   <ul>{plan.space.map(s=><li key={s.location}>{s.location==='cache'?'准备缓存卷':'目标卷'}：后续需要 {size(s.required)}，当前可用 {s.available===null?'未知':size(s.available)}</li>)}</ul>
   {unknown&&<label><input type="checkbox" checked={accept} disabled={edited||reading||busy} onChange={e=>setAccept(e.target.checked)}/>接受未完成的内容比较或未知空间估计；不将其视为没有重复或空间已证明充足</label>}
   {edited&&<p role="status">选择已改变，请更新预检后确认。</p>}
   <div className="tool-actions"><button disabled={reading||busy||job?.stale} onClick={()=>void inspection.start(()=>window.kmm.reviseModImport(gameId,plan.sessionId,choices))}>更新导入预检</button><button className="primary" disabled={edited||reading||busy||job?.stale||!plan.canCommit||unknown&&!accept} onClick={()=>void commit()}>确认导入所选 Mod</button></div>
  </>}
  {!plan&&job?.stage!=='running'&&!receipt&&<button onClick={()=>void inspection.start(()=>window.kmm.prepareModImport(gameId,source))}>重新选择并预检</button>}
 </section>;
}
