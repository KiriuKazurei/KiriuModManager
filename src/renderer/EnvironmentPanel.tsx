import {FeedbackNotice} from './Notices';
import {useEffect,useRef,useState} from 'react';
import type {GameId,Settings} from '../shared/contracts';
import type {EnvironmentRepairPreview,EnvironmentRepairRequest,EnvironmentScope} from '../shared/environment';
import {InspectionProgress,useInspectionJob} from './InspectionJob';
import {unwrap} from './ui';
const states={healthy:'路径检查通过','change-detected':'发现路径差异','needs-selection':'请选择候选','needs-component':'待安装游戏组件',transient:'有修复等待处理',unavailable:'未确认游戏位置',unknown:'需要进一步检查'};
const scopes={save:'仅保存验证路径','sync-game':'保存并同步 Launcher 游戏路径','sync-mods':'同时修复静态 Mod 读取规则'};
export function EnvironmentPanel({gameId,hidden,onBusy,onSaved}:{gameId:GameId;hidden:boolean;onBusy:(busy:boolean)=>void;onSaved:(settings:Settings)=>void}){
 const reader=useInspectionJob(gameId),[candidate,setCandidate]=useState(''),[scope,setScope]=useState<EnvironmentScope>('save'),[preview,setPreview]=useState<EnvironmentRepairPreview|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 const active=useRef({hidden,busy,reading:reader.job?.stage==='running'});active.current={hidden,busy,reading:reader.job?.stage==='running'};const mounted=useRef(true);
 const report=reader.job?.stage==='complete'&&reader.job.result?.kind==='environment'?reader.job.result:null;
 const invalid=!report||reader.job?.stale||reader.job?.stage==='running';
 async function check(mode:'quick'|'discover') {setPreview(null);setCandidate('');setMessage('');reader.clear();await reader.start(()=>window.kmm.checkGameEnvironment(gameId,mode));}
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{if(!hidden&&!reader.job)void check('quick');},[hidden,gameId]);
 useEffect(()=>{let timer:ReturnType<typeof setTimeout>|undefined;const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!active.current.hidden&&!active.current.busy&&!active.current.reading)void check('quick');},500);};window.addEventListener('focus',schedule);const unsubscribe=window.kmm.onDesktopChange(event=>{if(event.settingsChanged)schedule();});return()=>{clearTimeout(timer);window.removeEventListener('focus',schedule);unsubscribe();};},[gameId]);
 useEffect(()=>{setPreview(null);setCandidate('');},[report?.resultId,reader.job?.stale]);
 async function action(work:()=>Promise<void>){setBusy(true);onBusy(true);reader.setError('');setMessage('');try{await work();}catch(e){reader.setError((e as Error).message);}finally{if(mounted.current)setBusy(false);onBusy(false);}}
 async function prepare(request:EnvironmentRepairRequest){await action(async()=>setPreview(unwrap(await window.kmm.prepareEnvironmentRepair(gameId,request))));}
 async function choose(kind:'game'|'loader'){setPreview(null);setCandidate('');reader.clear();await reader.start(()=>window.kmm.chooseGameInstallation(gameId,kind));}
 async function apply(){if(!preview)return;const token=preview.token;await action(async()=>{const result=unwrap(await window.kmm.applyEnvironmentRepair(gameId,token));if(!result){setMessage('已取消提交，可继续检查预览。');return;}onSaved(result.settings);setPreview(null);setMessage(result.repair.message+(result.warnings.length?' '+result.warnings.join('；'):''));await reader.start(()=>window.kmm.checkGameEnvironment(gameId,'discover'));});}
 return <section className="environment-panel" aria-label="路径检查与修复" hidden={hidden} data-preview-token={preview?.token??''}>
  <h3>已保存路径状态</h3><p>游戏更新后的 Mod 兼容性仍需实际测试。</p>
  <div className="environment-actions"><button disabled={busy||reader.job?.stage==='running'} onClick={()=>void check('quick')}>轻检查</button><button disabled={busy||reader.job?.stage==='running'} onClick={()=>void check('discover')}>查找候选</button><button disabled={busy||reader.job?.stage==='running'} onClick={()=>void choose('game')}>重新定位游戏</button><button disabled={busy||reader.job?.stage==='running'} onClick={()=>void choose('loader')}>重新定位 XXMI</button></div>
  <InspectionProgress job={reader.job} error={reader.error} onCancel={()=>void reader.cancel()}/>
  <FeedbackNotice message={message}/>
  {report&&<><h3>{states[report.state]}</h3><dl><dt>{report.loader.importer} 组件</dt><dd>{report.loader.importerExists?'目录存在':'未安装'}<br/>{report.loader.importerDirectory}</dd><dt>已保存游戏目录</dt><dd>{report.paths.gameDirectory||'未配置'}</dd><dt>实际 EXE</dt><dd>{report.executable||'尚未确认'}</dd><dt>Launcher 目标</dt><dd>{report.loader.gameDirectory||'未配置'}</dd><dt>loader 读取目录</dt><dd>{report.loader.modsDirectories.join('；')||'尚未确认'}</dd><dt>Mod 库</dt><dd>{report.paths.modsDirectory||'未配置'} · {report.capabilities.manageMods?'可独立管理':'目录尚未确认'}</dd></dl><ul>{report.issues.map(issue=><li key={issue}>{issue}</li>)}</ul>
   <label>修复候选<select aria-label="环境修复候选" disabled={busy||invalid} value={candidate} onChange={e=>{setCandidate(e.target.value);setPreview(null);}}><option value="">请选择，不自动采用候选</option>{report.candidates.map(c=><option key={c.id} value={c.id}>{c.name} · {c.source} · {c.paths.gameDirectory||c.paths.xxmiRoot}</option>)}</select></label>
   {candidate&&<p className="environment-candidate">游戏：{report.candidates.find(c=>c.id===candidate)?.paths.gameDirectory||'未配置'}<br/>XXMI：{report.candidates.find(c=>c.id===candidate)?.paths.xxmiRoot||'未配置'}</p>}
   <label>修复范围<select aria-label="环境修复范围" value={scope} disabled={busy} onChange={e=>{setScope(e.target.value as EnvironmentScope);setPreview(null);}}>{Object.entries(scopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><button disabled={busy||invalid||!candidate} onClick={()=>void prepare({kind:'repair',resultId:report.resultId,candidateId:candidate,scope})}>预览路径修复</button>
   <details><summary>环境修复记录（{report.repairs.length}）</summary>{report.repairs.map(r=><div className="environment-record" key={r.id}><span>{new Date(r.createdAt).toLocaleString('zh-CN')} · {scopes[r.scope]} · {r.phase}<br/>{r.message}</span><button disabled={busy||r.phase==='rolled-back'} aria-label={'预览回退 '+r.id} onClick={()=>void prepare({kind:'rollback',repairId:r.id})}>预览回退</button></div>)}<button onClick={()=>void action(async()=>{unwrap(await window.kmm.revealManagedLocation(gameId,{kind:'storage',category:'environment-repairs'}));})}>查看修复副本位置</button></details>
  </>}
  {preview&&<div className="environment-preview" role="region" aria-label="环境修复预览"><h3>{preview.action==='rollback'?'回退预览':'路径修复预览'}</h3><p>{scopes[preview.scope]} · 预览两分钟内有效；最终提交仍会重新检查。</p>{preview.changes.length?<table><thead><tr><th>项目</th><th>当前值</th><th>提交后</th></tr></thead><tbody>{preview.changes.map((c,i)=><tr key={i}><th scope="row">{c.role}</th><td>{c.before||'未配置'}</td><td>{c.after||'未配置'}</td></tr>)}</tbody></table>:<p>路径值保持，提交会记录已确认的环境。</p>}<ul>{preview.warnings.map(w=><li key={w}>{w}</li>)}</ul><button disabled={busy||reader.job?.stale} onClick={()=>void apply()}>确认{preview.action==='rollback'?'回退':'路径修复'}</button><button disabled={busy} onClick={()=>setPreview(null)}>关闭预览</button></div>}
 </section>;
}
