import {useEffect,useRef,useState} from 'react';
import type {GameId} from '../shared/contracts';
import type {CompatibilityStatus} from '../shared/compatibility';
import {unwrap} from './ui';
const labels={unverified:'尚未测试',passed:'进程层测试通过',failed:'进程层测试失败',inconclusive:'证据不足',stale:'记录已过期',unknown:'当前环境未确认'};
const checkLabels={passed:'通过',failed:'失败',inconclusive:'证据不足'};
export function CompatibilityPanel({gameId,hidden}:{gameId:GameId;hidden:boolean}){
 const [status,setStatus]=useState<CompatibilityStatus|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const sequence=useRef(0),visible=useRef(!hidden);visible.current=!hidden;
 async function read(importRecord=false){const id=++sequence.current;setBusy(true);setError('');try{let value=unwrap(await (importRecord?window.kmm.importCompatibilityEvidence(gameId):window.kmm.compatibilityStatus(gameId)));if(!value)value=unwrap(await window.kmm.compatibilityStatus(gameId));if(sequence.current===id)setStatus(value);}catch(e){if(sequence.current===id){setError((e as Error).message);setStatus(previous=>previous?{...previous,state:'unknown',message:'本次核对失败，不能沿用此前通过状态。'}:null);}}finally{if(sequence.current===id)setBusy(false);}}
 useEffect(()=>{if(!hidden)void read();return()=>{sequence.current++;};},[gameId,hidden]);
 useEffect(()=>{let timer:ReturnType<typeof setTimeout>;const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(visible.current)void read();},500);};window.addEventListener('focus',schedule);const off=window.kmm.onDesktopChange(event=>{if(event.settingsChanged)schedule();});return()=>{clearTimeout(timer);off();window.removeEventListener('focus',schedule);};},[gameId]);
 const record=status?.evidence;
 return <section className="card compatibility-panel" aria-label="进程兼容测试" hidden={hidden}>
  <h2>进程兼容测试</h2><p>检查管理器与 XXMI 的进程重启和异常退出恢复。Mod 内容兼容性仍以人工验证为准。</p>
  <div className="environment-actions"><button disabled={busy} onClick={()=>void read()}>检查记录适用性</button><button disabled={busy} onClick={()=>void read(true)}>导入 SDK 测试记录</button></div>
  {error&&<p role="alert">{error}</p>}<p role="status">{busy?'正在核对当前环境…':status?labels[status.state]+'：'+status.message:'尚未读取记录。'}</p>
  {record&&<details><summary>查看本地测试记录</summary><dl><dt>测试范围</dt><dd>进程重启与恢复；未验证画面、输入、Mod 加载效果或刷新</dd><dt>测试时间</dt><dd>{new Date(record.testedAt).toLocaleString('zh-CN')}</dd><dt>管理器版本</dt><dd>{record.managerVersion}</dd><dt>检查项目</dt><dd>本地接入：{checkLabels[record.checks.local]}；重启：{checkLabels[record.checks.restart]}；恢复：{checkLabels[record.checks.recovery]}</dd><dt>现场恢复</dt><dd>{record.recoveryComplete?'已完成':'未完成，需先处理 SDK 恢复记录'}</dd><dt>游戏构建指纹</dt><dd>{record.target.gameBuild.slice(0,16)}</dd><dt>源码指纹</dt><dd>{record.sourceDigest.slice(0,16)}</dd></dl><p>由用户从本地 SDK 导入，摘要用于检查记录完整性；不是远程签名认证。检测范围为游戏 EXE、已知版本文件、XXMI 组件、Core 与管理器代码，不含游戏全部资源。</p></details>}
 </section>;
}
