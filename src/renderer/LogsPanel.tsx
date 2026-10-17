import {FeedbackNotice} from './Notices';
import {useEffect,useState} from 'react';
import type {GameId} from '../shared/contracts';
import type {LogReport} from '../shared/logging';
import {unwrap} from './ui';
export function LogsPanel({gameId,onNavigate}:{gameId:GameId;onNavigate:(page:'conflicts'|'recovery')=>void}){
 const [report,setReport]=useState<LogReport|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{setReport(null);setError('');setMessage('');},[gameId]);
 async function action(work:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await work();}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
 return <section className="card logs-panel" aria-labelledby="logs-title"><h2 id="logs-title">日志</h2><p className="hint">操作、后台任务与异常记录默认保存在管理器安装目录的 log 文件夹，可用于排查和溯源。</p>
  <div className="log-actions"><button disabled={busy} onClick={()=>void action(async()=>{unwrap(await window.kmm.openLogDirectory());setMessage('已请求打开日志目录。');})}>打开日志目录</button><button disabled={busy} onClick={()=>void action(async()=>setReport(unwrap(await window.kmm.logReport(gameId))))}>{report?'刷新日志分析':'分析日志'}</button></div>
  <FeedbackNotice error={error}/><FeedbackNotice message={message}/>
  {report&&<><p className="log-location">实际目录：<code>{report.directory}</code></p>{(report.fallback||!report.writable||report.writeFailures>0)&&<p className="mismatch">{report.fallback?'安装目录无法写入，当前使用用户数据目录保存日志。':''}{!report.writable?'日志写入存在失败，请检查空间与权限；部分记录可能缺失。':''}{report.writeFailures>0?`本会话累计 ${report.writeFailures} 次写入失败。`:''}</p>}
   <p className="hint">分析 {report.files} 个文件、{report.records} 条记录，损坏或残缺行 {report.malformedLines} 条。{report.truncated?'已达到读取上限，仅分析保留日志的最近部分。':'结果仅覆盖当前保留的日志。'}会话：<code>{report.sessionId}</code></p>
   {!report.findings.length&&<p className="success">当前分析范围内未发现已记录的错误线索。</p>}
   <div className="diagnostic-facts">{report.findings.map(finding=><article className={'diagnostic-fact status-'+finding.level} key={finding.kind}><strong>{finding.title} · {finding.count} 条记录</strong><p>{finding.explanation}</p>{finding.kind==='mod-conflict-candidates'&&<button onClick={()=>onNavigate('conflicts')}>查看候选冲突</button>}{finding.kind==='unfinished-operation'&&<button onClick={()=>onNavigate('recovery')}>查看备份与恢复</button>}<details><summary>查看日志依据</summary>{finding.evidence.map((entry,index)=><code className="evidence-line" key={index}>{entry.time} · {entry.event} · {entry.action}<br/>会话 {entry.sessionId}{entry.operationId?' · 操作 '+entry.operationId:''}{entry.code?' · '+entry.code:''}{entry.message?<><br/>{entry.message}</>:null}</code>)}</details></article>)}</div>
   <details><summary>最近警告与错误（{report.recent.length}）</summary>{report.recent.map((entry,index)=><div className="log-entry" key={index}><strong>{entry.level} · {entry.event}</strong><code>{entry.time} · {entry.action||'后台事件'}</code><code>会话 {entry.sessionId}{entry.operationId?' · 操作 '+entry.operationId:''}</code>{entry.message&&<p>{entry.message}</p>}</div>)}</details>
  </>}
 </section>;
}
