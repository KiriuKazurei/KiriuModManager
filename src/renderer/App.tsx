import { useEffect, useState, useRef } from 'react';
import { GameId, GAMES, Settings } from '../shared/contracts';
import { SettingsPage } from './SettingsPage';
import { ModPage } from './ModPage';
import {CharacterGallery,CharacterScope} from './CharacterGallery';
import { Icon, unwrap } from './ui';
import { BusinessPage, BusinessPageKind } from './BusinessPage';
import { IniEditor } from './IniEditor';
import { ThemeControl } from './theme';
import { DesktopSettings } from './DesktopSettings';
import {AppUpdatePanel} from './AppUpdatePanel';
import { useSidebarLayout } from './sidebar-layout';
export function App() {
  const [settings,setSettings]=useState<Settings|null>(null);
  const [page,setPage]=useState<'mods'|'preferences'|BusinessPageKind>('preferences');
  const sidebar=useSidebarLayout();
  const [scope,setScope]=useState<CharacterScope|null>(null);const selectedGameRef=useRef<GameId|null>(null);
  function acceptSettings(next:Settings){if(selectedGameRef.current!==next.selectedGame){setScope(null);setIniId('');}selectedGameRef.current=next.selectedGame;setSettings(next);}
  const [iniId,setIniId]=useState('');const [settingsRevision,setSettingsRevision]=useState(0);
  const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const [desktopMessage,setDesktopMessage]=useState('');
  async function load(){setError('');try{const data=unwrap(await window.kmm.readSettings());acceptSettings(data);setPage(data.games[data.selectedGame].modsDirectory?'mods':'preferences');}catch(e){setError((e as Error).message);}}
  useEffect(()=>{void load();},[]);
  useEffect(()=>window.kmm.onDesktopChange(event=>{if(!event.settingsChanged)return;void window.kmm.readSettings().then(result=>{try{acceptSettings(unwrap(result));}catch(e){setError((e as Error).message);}});}),[]);
  async function desktopAction(work:()=>Promise<string|void>){setBusy(true);setError('');setDesktopMessage('');try{setDesktopMessage(await work()||'桌面操作已完成。');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function selectGame(game:GameId) {
    setBusy(true);setError('');
    try { const saved=unwrap(await window.kmm.selectGame(game));acceptSettings(saved); }
    catch(e){setError((e as Error).message);} finally {setBusy(false);}
  }
  if(!settings) return <main className="loading"><h1>Kiriu Mod Manager</h1><p role={error?'alert':'status'}>{error||'正在读取本地工作区…'}</p>{error&&<button onClick={()=>void load()}>重试读取</button>}</main>;
  const game=settings.selectedGame;
  const navButton=(key:typeof page,label:string,icon:Parameters<typeof Icon>[0]['kind'],onClick=()=>setPage(key))=><button key={key} className={page===key?'active':''} aria-current={page===key?'page':undefined} title={sidebar.collapsed?label:undefined} aria-label={sidebar.collapsed?label:undefined} disabled={busy} onClick={onClick}><Icon kind={icon}/><span className="nav-text">{label}</span></button>;
  return <div className={`app-shell ${sidebar.collapsed?'sidebar-collapsed':''}`} style={sidebar.shellStyle}>
    <aside className="sidebar"><div className="sidebar-head"><div className="brand"><span className="brand-mark">K</span><div>KIRIU<span>MOD MANAGER</span></div></div><button type="button" className="sidebar-toggle" aria-label={sidebar.collapsed?'展开侧边栏':'折叠侧边栏'} aria-expanded={!sidebar.collapsed} title={sidebar.collapsed?'展开侧边栏':'折叠侧边栏'} onClick={sidebar.toggle}><Icon kind="panel"/></button></div><div className="nav-label">游戏配置</div>
      <nav className="game-nav" aria-label="游戏配置"><label className="sr-only" htmlFor="current-game">当前游戏</label><select id="current-game" aria-label="当前游戏" className="current-game-select" value={game} disabled={busy} onChange={event=>void selectGame(event.target.value as GameId)}>{(Object.keys(GAMES) as GameId[]).map(id=><option key={id} value={id}>{GAMES[id].name} · {GAMES[id].importer}</option>)}</select></nav>
      <div className="nav-label">管理</div><nav aria-label="主要导航">{navButton('mods','Mod 库','grid',()=>{setScope(null);setPage('mods');})}</nav>
      <nav className="tools-nav" aria-label="工作区工具">{navButton('conflicts','候选冲突','grid')}{navButton('recovery','备份与恢复','folder')}<button title={sidebar.collapsed?'快速管理浮窗':undefined} aria-label={sidebar.collapsed?'快速管理浮窗':undefined} disabled={busy} onClick={()=>void desktopAction(async()=>{unwrap(await window.kmm.floating(true));})}><Icon kind="grid"/><span className="nav-text">快速管理浮窗</span></button></nav>
      <nav className="sidebar-footer" aria-label="预设与设置">{navButton('presets','预设','grid')}{navButton('preferences','设置','settings')}</nav>
      {!sidebar.collapsed&&<div className="sidebar-resizer" {...sidebar.resizerProps}/>}
    </aside>
    <div className="workspace"><header className="workspace-bar"><span>{GAMES[game].name}<small>{GAMES[game].subtitle}</small></span><div className="desktop-actions"><ThemeControl/><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.launchXXMI(game,'gui').then(unwrap))}>打开 XXMI</button><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.launchXXMI(game,'game').then(unwrap))}>启动游戏</button><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.refreshGame(game).then(unwrap))}>请求刷新</button><details className="desktop-menu"><summary>更多</summary><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.openLink(game,'market').then(unwrap))}>打开 Mod 网页</button><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.openLink(game,'update').then(unwrap))}>打开更新发布页</button><button onClick={()=>void window.kmm.quit()}>退出管理器</button></details></div></header>{error&&<p className="error shell-error" role="alert">{error}</p>}{desktopMessage&&<p className="success shell-error" role="status">{desktopMessage}</p>}
      {page==='mods'&&(scope?<ModPage key={game} gameId={game} scope={scope} onBack={()=>setScope(null)} savedRoot={settings.games[game].modsDirectory} onBusy={setBusy} onSettings={()=>setPage('preferences')} onIni={setIniId}/>:<CharacterGallery key={game} gameId={game} savedRoot={settings.games[game].modsDirectory} onBusy={setBusy} onSettings={()=>setPage('preferences')} onOpen={setScope}/>)}
      <main className="business-page preferences-page" hidden={page!=='preferences'}><div className="page-heading"><div><h1>设置</h1></div></div><SettingsPage key={settingsRevision} initialSettings={settings} gameId={game} hidden={false} onSaved={acceptSettings} onBusy={setBusy}/><DesktopSettings hidden={page!=='preferences'}/><AppUpdatePanel hidden={page!=='preferences'} onBusy={setBusy}/></main>
      {(page==='presets'||page==='conflicts'||page==='recovery')&&<BusinessPage key={`${game}-${page}`} kind={page} gameId={game} onBusy={setBusy} onRestored={async()=>{acceptSettings(unwrap(await window.kmm.readSettings()));setSettingsRevision(value=>value+1);}}/>}
      {iniId&&<IniEditor gameId={game} modId={iniId} onClose={()=>setIniId('')} onBusy={setBusy}/>}
    </div>
  </div>;
}
