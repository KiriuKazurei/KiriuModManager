import {ModImportPanel} from './ModImportPanel';
import {useEffect,useState} from 'react';
import type {GameId,ModBrowserStatus,ModDownload,ModDownloadAction,ModDownloadInstallPlan,ModInstallDestination} from '../shared/contracts';
import {unwrap} from './ui';
import {GAMES} from '../shared/contracts';
const stageNames:Record<ModDownload['stage'],string>={binding:'读取信息',downloading:'下载中',verifying:'校验中',ready:'待安装',installing:'安装中',complete:'已安装',partial:'部分完成',error:'失败',canceled:'已取消',interrupted:'已中断','waiting-directory':'等待选择目录'};
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024**2?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1024**2).toFixed(1)} MiB`;
const active=(task:ModDownload)=>['binding','downloading','verifying','installing'].includes(task.stage);
const waiting=(task:ModDownload)=>['ready','waiting-directory'].includes(task.stage);
const filters=['全部','下载中','待安装','已下载','已安装','未完成'] as const;
export function ModDownloadsPage({modsRoots,onLibrary,onBrowse}:{modsRoots:Record<GameId,string>;onLibrary:(game:GameId,id:string)=>void;onBrowse:()=>void}){
 const [preparing,setPreparing]=useState<{taskId:string;gameId:GameId}|null>(null);
 const [updateEntries,setUpdateEntries]=useState<Record<string,string>>({});
 const [status,setStatus]=useState<ModBrowserStatus|null>(null);const [error,setError]=useState('');const [busyId,setBusyId]=useState('');
 const [filter,setFilter]=useState<typeof filters[number]>('全部');const [plans,setPlans]=useState<Record<string,ModDownloadInstallPlan>>({});
 useEffect(()=>{let alive=true,polling=false;const poll=async()=>{if(polling)return;polling=true;try{const result=unwrap(await window.kmm.modBrowserStatus());if(alive)setStatus(result);}catch(e){if(alive)setError((e as Error).message);}finally{polling=false;}};void poll();const timer=setInterval(()=>void poll(),600);return()=>{alive=false;clearInterval(timer);};},[]);
 useEffect(()=>{setPlans({});},[modsRoots.zzz,modsRoots.endfield]);
 async function perform(id:string,work:()=>Promise<void>){setBusyId(id);setError('');try{await work();}catch(e){setError((e as Error).message);}finally{setBusyId('');}}
 async function action(id:string,operation:ModDownloadAction,destinations?:ModInstallDestination[]){await perform(id,async()=>{const next=unwrap(await window.kmm.modDownloadAction(id,operation,destinations));setStatus(next);if(['complete','partial'].includes(next.downloads.find(task=>task.id===id)?.stage||''))setPlans(previous=>{const copy={...previous};delete copy[id];return copy;});});}
 async function plan(id:string){await perform(id,async()=>{const result=unwrap(await window.kmm.modDownloadInstallPlan(id));setPlans(previous=>({...previous,[id]:result}));});}
 function changeFolder(id:string,entryPath:string,folder:string){setPlans(previous=>({...previous,[id]:{...previous[id],folders:[...new Set([...previous[id].folders,folder])],items:previous[id].items.map(item=>item.entryPath===entryPath?{...item,folder}:item)}}));}
 async function chooseFolder(id:string,entryPath:string){await perform(id,async()=>{const current=plans[id];const item=current.items.find(item=>item.entryPath===entryPath)!;const chosen=unwrap(await window.kmm.chooseDirectory([current.targetRoot,item.folder].filter(Boolean).join('/')));if(!chosen)return;const root=current.targetRoot.replaceAll('\\','/').replace(/\/+$/,'');const folder=chosen.replaceAll('\\','/').replace(/\/+$/,'');if(folder.toLowerCase()!==root.toLowerCase()&&!folder.toLowerCase().startsWith(root.toLowerCase()+'/'))throw new Error('请选择当前 Mod 目录内的角色或分类文件夹；根目录请在设置中调整。');changeFolder(id,entryPath,folder.slice(root.length).replace(/^\//,''));});}
 const tasks=[...(status?.downloads||[])].reverse();
 const visible=tasks.filter(task=>filter==='全部'||filter==='下载中'&&active(task)||filter==='待安装'&&waiting(task)||filter==='已下载'&&task.archiveReady||filter==='已安装'&&task.stage==='complete'||filter==='未完成'&&!active(task)&&!waiting(task)&&task.stage!=='complete');
 return <main className="business-page downloads-page" aria-label="下载进度">
  <div className="page-heading"><div><h1>下载进度</h1><p className="mod-business-note">管理下载中的任务、已下载资源和历史记录。安装完成后保持停用，请到 Mod 库手动开启。</p></div><button onClick={onBrowse}>获取Mod</button></div>
  <div className="download-summary"><span><strong>{tasks.filter(active).length}</strong> 正在处理</span><span><strong>{tasks.filter(waiting).length}</strong> 等待安装</span><span><strong>{tasks.filter(task=>task.archiveReady).length}</strong> 完整资源</span><span><strong>{tasks.length}</strong> 下载记录</span></div>
  <div className="download-filters" role="group" aria-label="筛选下载记录">{filters.map(item=><button key={item} aria-pressed={filter===item} className={filter===item?'active':''} onClick={()=>setFilter(item)}>{item}</button>)}</div>
  {preparing&&<ModImportPanel key={preparing.taskId} gameId={preparing.gameId} source={{kind:'download',taskId:preparing.taskId}} onClose={()=>setPreparing(null)} onComplete={()=>{void window.kmm.modBrowserStatus().then(result=>{if(result.ok)setStatus(result.value);});}}/>}
  {(error||status?.error)&&<p className="error" role="alert">{error||status?.error}</p>}
  {!visible.length&&<div className="empty-state"><h2>{tasks.length?'此分类暂无记录':'暂无下载记录'}</h2><p>在获取Mod页面选择 GameBanana 托管的 ZIP、7z 或 RAR 下载。</p></div>}
  <div className="download-list">{visible.map(task=>{
   const busy=busyId===task.id;const ended=!active(task);const currentPlan=plans[task.id];const installable=ended&&task.archiveReady&&task.stage!=='complete'&&task.stage!=='waiting-directory';
   return <article className="download-card" key={task.id} data-task-id={task.id}>
    <div className="download-card-heading"><div><h2>{task.title}</h2><p className="market-file">{task.fileName}</p></div><span className={`download-state ${task.stage==='complete'?'success':task.stage==='error'?'error':''}`}>{GAMES[task.gameId].name} · {stageNames[task.stage]}</span></div>
    {active(task)&&<progress aria-label={`${task.title}下载进度`} max={task.totalBytes||1} value={task.receivedBytes}/>}
    <p className="download-bytes">{size(task.receivedBytes)} / {size(task.totalBytes)}<span>{new Date(task.createdAt).toLocaleString('zh-CN')}</span></p>
    <p className={task.stage==='error'||task.stage==='partial'?'error':task.stage==='complete'?'success':'mod-business-note'} role="status">{task.message}</p>
    <details className="download-details"><summary>资源信息与任务目录</summary><dl><dt>安装根目录</dt><dd><code>{task.targetRoot||'未配置，请到设置中保存 Mod 目录'}</code></dd><dt>角色匹配</dt><dd>{task.character||'安装时按包内名称匹配；也可手动选择文件夹'}</dd><dt>资源状态</dt><dd>{task.archiveReady?'完整压缩包已保存':'没有可用的完整压缩包'}</dd></dl></details>
    {task.items.length>0&&<ul className="market-install-items">{task.items.map((item,index)=><li key={item.id||index} className={item.ok?'success':'error'}>{item.name}：{item.ok?(item.existing?'已有项保持':task.updateTarget?'已替换，保持原启停状态':'已安装，默认停用'):item.error}</li>)}</ul>}
    {currentPlan&&<div className="download-install-plan">{currentPlan.updatePreview&&<div className="update-preview"><h3>替换 {currentPlan.updatePreview.name}</h3><p>声明版本：{currentPlan.updatePreview.versionBefore||'未知'} → {currentPlan.updatePreview.versionAfter||'未知'} · 原状态：{currentPlan.updatePreview.enabled?'启用':'停用'}</p><p>{currentPlan.updatePreview.activeProfile?'此 Mod 属于活动配置，将捕获新包配置；其它配置须适配。':'已有配置副本保留，旧内容修订禁止直接写回。'}旧完整内容先留恢复副本，新 INI 使用新包配置。</p><ul>{currentPlan.items.find(item=>item.entryPath===(updateEntries[task.id]??currentPlan.items[0]?.entryPath))?.configChanges?.map(file=><li key={file.relativePath}>{{added:'新增',removed:'移除',changed:'改变',same:'相同'}[file.kind]}：{file.relativePath}</li>)}</ul></div>}<h3>{currentPlan.updateTarget?'选择替换条目':'安装位置'}</h3><p className="mod-business-note">位置相对于此任务的 Mod 根目录。自动匹配结果可修改；未识别的角色请手动选择。</p>{currentPlan.updateTarget?<label>一个候选包内条目<select aria-label="更新包内条目" value={updateEntries[task.id]??currentPlan.items[0]?.entryPath} onChange={e=>setUpdateEntries(v=>({...v,[task.id]:e.target.value}))}>{currentPlan.items.map(item=><option key={item.entryPath} value={item.entryPath}>{item.name} / {item.entryPath||'根条目'}</option>)}</select></label>:currentPlan.items.map(item=><div className="download-destination" key={item.entryPath}><label>{item.name}{item.character&&<small>匹配角色：{item.character}</small>}<select aria-label={`${item.name}安装文件夹`} value={item.folder} disabled={busy} onChange={event=>changeFolder(task.id,item.entryPath,event.target.value)}>{currentPlan.folders.map(folder=><option key={folder} value={folder}>{folder||'Mod 根目录'}</option>)}</select></label><button disabled={busy} onClick={()=>void chooseFolder(task.id,item.entryPath)}>选择文件夹</button></div>)}<button disabled={busy} onClick={()=>setPlans(previous=>{const copy={...previous};delete copy[task.id];return copy;})}>收起位置选择</button></div>}
    <div className="market-task-actions">
     {['binding','downloading','verifying'].includes(task.stage)&&<button disabled={busy} onClick={()=>void action(task.id,'cancel')}>取消下载</button>}
     {ended&&task.archiveReady&&<button disabled={busy} onClick={()=>void action(task.id,'show-file')}>查看压缩包</button>}
     {installable&&<><button className="primary" disabled={busy} onClick={()=>!task.updateTarget?setPreparing({taskId:task.id,gameId:task.gameId}):task.updateTarget&&!currentPlan?void plan(task.id):void action(task.id,'retry-install',currentPlan?.updateTarget?[{entryPath:updateEntries[task.id]??currentPlan.items[0].entryPath,folder:''}]:currentPlan?.items.map(({entryPath,folder})=>({entryPath,folder})))}>{busy?'正在处理…':task.updateTarget?(currentPlan?'确认替换此 Mod':'读取更新包条目'):'预检安装'}</button>{!currentPlan&&task.updateTarget&&<button disabled={busy} onClick={()=>void plan(task.id)}>选择安装位置</button>}</>}
     {task.stage==='waiting-directory'&&!task.updateTarget&&<button className="primary" disabled={busy} onClick={()=>void action(task.id,'install-current')}>使用当前目录准备安装</button>}
     {ended&&task.stage!=='complete'&&task.stage!=='ready'&&<><button disabled={busy} onClick={()=>void action(task.id,'retry-download')}>重新下载</button><button disabled={busy} onClick={()=>void action(task.id,'retry-binding')}>重读 Mod 信息</button></>}
     {task.items.some(item=>item.ok&&item.id)&&<button disabled={busy||task.targetRoot.toLowerCase()!==modsRoots[task.gameId].toLowerCase()} title={task.targetRoot.toLowerCase()!==modsRoots[task.gameId].toLowerCase()?'请在设置中切回此任务的根目录后查看':undefined} onClick={()=>onLibrary(task.gameId,task.items.find(item=>item.ok&&item.id)!.id!)}>查看已安装 Mod</button>}
    </div>
   </article>;
  })}</div>
 </main>;
}
