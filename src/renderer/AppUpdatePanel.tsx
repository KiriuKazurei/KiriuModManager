import {useEffect,useState} from 'react';
import {DEFAULT_APP_UPDATE_SOURCE} from '../shared/contracts';
import type {AppUpdateStatus} from '../shared/contracts';
import {unwrap} from './ui';

export function AppUpdatePanel({hidden,onBusy}:{hidden:boolean;onBusy:(value:boolean)=>void}) {
 const [source,setSource]=useState(DEFAULT_APP_UPDATE_SOURCE);const [baseline,setBaseline]=useState(DEFAULT_APP_UPDATE_SOURCE);
 const [status,setStatus]=useState<AppUpdateStatus|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 useEffect(()=>{let active=true;const load=()=>{void window.kmm.readSettings().then(result=>{if(!active||!result.ok)return;const latest=result.value.desktop?.updateSourceUrl??DEFAULT_APP_UPDATE_SOURCE;setSource(previous=>previous===baseline?latest:previous);setBaseline(latest);});};load();const off=window.kmm.onDesktopChange(event=>{if(event.settingsChanged)load();});return()=>{active=false;off();};},[baseline]);
 useEffect(()=>{if(hidden)return;let active=true;const poll=async()=>{try{const next=unwrap(await window.kmm.appUpdateStatus());if(active)setStatus(next);}catch(e){if(active)setError((e as Error).message);}};void poll();const timer=setInterval(()=>void poll(),750);return()=>{active=false;clearInterval(timer);};},[hidden]);
 async function action(work:()=>Promise<void>){setBusy(true);onBusy(true);setError('');setNotice('');try{await work();}catch(e){setError((e as Error).message);}finally{setBusy(false);onBusy(false);}}
 const updating=busy||!!status&&['checking','downloading','verifying','installing'].includes(status.stage);const dirty=source!==baseline;
 return <section className="card app-update-panel" aria-labelledby="app-update-title">
  <h2 id="app-update-title">管理器更新</h2><p className="hint">当前版本 {status?.currentVersion||'读取中'} · 从发布源检查稳定版本，确认后下载。</p>
  <form onSubmit={e=>{e.preventDefault();const submitted=source;void action(async()=>{const saved=unwrap(await window.kmm.saveDesktopPreferences({updateSourceUrl:submitted}));const latest=saved.desktop?.updateSourceUrl??DEFAULT_APP_UPDATE_SOURCE;setSource(previous=>previous===submitted?latest:previous);setBaseline(latest);setNotice('更新源已保存，请重新检查版本。');setStatus(null);});}}>
   <label htmlFor="app-update-source">更新源地址</label><input id="app-update-source" type="url" value={source} disabled={updating} onChange={e=>{setSource(e.target.value);setNotice('');setError('');}} placeholder="GitHub 仓库或 HTTPS 更新清单"/>
   <p className="hint">默认使用 KiriuModManager 的 GitHub 发布版本。其它 HTTPS 地址需提供更新清单；留空可禁用检查。</p><button disabled={updating||!dirty}>保存更新源</button>
  </form>
  <div className="tool-actions"><button disabled={updating||dirty} onClick={()=>void action(async()=>setStatus(unwrap(await window.kmm.checkAppUpdate())))}>检查更新</button>
   <button disabled={updating||dirty||!status?.canInstall||!status.release||!['available','error'].includes(status.stage)} title={!status?.release?'请先检查是否有新版本':!status.canInstall?'源码运行模式不能替换程序，请使用发行版更新':'确认后下载并校验更新包'} onClick={()=>void action(async()=>{const result=unwrap(await window.kmm.downloadAppUpdate());if(result)setStatus(result);else setNotice('已取消下载。');})}>获取更新</button>
   {status?.stage==='ready'&&<button className="primary" disabled={updating||dirty} onClick={()=>void action(async()=>{const result=unwrap(await window.kmm.installAppUpdate());if(result)setStatus(result);else setNotice('已取消安装，更新包保留。');})}>退出并安装更新</button>}
  </div>
  {dirty&&<p className="hint">先保存更新源，再检查版本。</p>}
  {status?.release&&<div className="update-release"><h3>发布版本 {status.release.version}</h3><p className="hint">{new Date(status.release.publishedAt).toLocaleString('zh-CN')} · {(status.release.size/1024**2).toFixed(1)} MiB</p><pre className="update-notes">{status.release.notes||'此版本没有填写更新说明。'}</pre></div>}
  {status&&<p role="status" aria-live="polite">{status.message}</p>}
  {status&&['downloading','verifying'].includes(status.stage)&&<progress aria-label="更新进度" max={100} value={status.percent}>{status.percent}%</progress>}
  {status&&!status.canInstall&&<p className="hint">当前为源码运行模式。安装更新请使用 Windows x64 便携发行包。</p>}
  {status?.lastResult&&<p className="hint">上次更新：{status.lastResult.stage==='success'?'已安装并重新打开':status.lastResult.stage==='rolled-back'?'失败，已恢复旧版':status.lastResult.message}{status.lastResult.backup&&` · 旧程序目录：${status.lastResult.backup}`}</p>}
  {notice&&<p className="success" role="status">{notice}</p>}{error&&<p className="error" role="alert">{error}</p>}
 </section>;
}
