import {FeedbackNotice} from './Notices';
import {CompatibilityPanel} from './CompatibilityPanel';
import {DiagnosticsPanel} from './DiagnosticsPanel';
import {reportRendererEvent} from './logging';
import {RecoveryPage} from './RecoveryPage';
import {ConflictPage} from './ConflictPage';
import type {IniNavigationTarget} from '../shared/inspections';
import { useEffect, useState, useRef } from 'react';
import { GameId, GAMES, Settings, type DesktopLaunchResult } from '../shared/contracts';
import {type NoticeTone} from './notice-store';
import { SettingsPage } from './SettingsPage';
import { ModPage } from './ModPage';
import {CharacterGallery,CharacterScope} from './CharacterGallery';
import { Icon, unwrap } from './ui';
import { BusinessPage, BusinessPageKind } from './BusinessPage';
import { IniEditor } from './IniEditor';
import { ThemeControl } from './theme';
import { DesktopSettings } from './DesktopSettings';
import {AboutPage} from './AboutPage';
import { useSidebarLayout } from './sidebar-layout';
import {ModBrowserPage} from './ModBrowserPage';
import {ModDownloadsPage} from './ModDownloadsPage';
export function App() {
  const [settings,setSettings]=useState<Settings|null>(null);
  const [page,setPage]=useState<'mods'|'market'|'downloads'|'preferences'|BusinessPageKind>('preferences');
  const sidebar=useSidebarLayout();
  const [settingsTab,setSettingsTab]=useState<'general'|'diagnostics'|'about'>('general');
  const [scope,setScope]=useState<CharacterScope|null>(null);const selectedGameRef=useRef<GameId|null>(null);const selectedRootRef=useRef('');
  const [initialModId,setInitialModId]=useState('');
  function acceptSettings(next:Settings){const root=next.games[next.selectedGame].modsDirectory;if(selectedGameRef.current!==next.selectedGame||selectedRootRef.current!==root){setScope(null);setIniId('');setInitialModId('');}selectedGameRef.current=next.selectedGame;selectedRootRef.current=root;setSettings(next);}
  const [iniTarget,setIniTarget]=useState<IniNavigationTarget|null>(null);
  const [iniId,setIniId]=useState('');const [settingsRevision,setSettingsRevision]=useState(0);
  const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const [desktopMessage,setDesktopMessage]=useState('');
  const [desktopTone,setDesktopTone]=useState<NoticeTone>('success');
  async function load(){setError('');try{const data=unwrap(await window.kmm.readSettings());acceptSettings(data);setPage(data.games[data.selectedGame].modsDirectory?'mods':'preferences');}catch(e){setError((e as Error).message);}}
  useEffect(()=>{void load();},[]);
  useEffect(()=>{reportRendererEvent({kind:'navigation',page:page+(page==='preferences'?':'+settingsTab:''),gameId:settings?.selectedGame});},[page,settingsTab,settings?.selectedGame]);
  useEffect(()=>window.kmm.onDesktopChange(event=>{if(!event.settingsChanged)return;void window.kmm.readSettings().then(result=>{try{acceptSettings(unwrap(result));}catch(e){setError((e as Error).message);}});}),[]);
  async function desktopAction(work:()=>Promise<string|DesktopLaunchResult|void>){setBusy(true);setError('');setDesktopMessage('');try{const result=await work();setDesktopTone(typeof result==='object'&&result.status==='unconfirmed'?'warning':'success');setDesktopMessage(typeof result==='object'?result.message:result||'桌面操作已完成。');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  async function selectGame(game:GameId) {
    setBusy(true);setError('');
    try { const saved=unwrap(await window.kmm.selectGame(game));acceptSettings(saved);return true; }
    catch(e){setError((e as Error).message);return false;} finally {setBusy(false);}
  }
  if(!settings) return <main className="loading"><h1>Kiriu Mod Manager</h1><FeedbackNotice error={error}/><p role="status">{error?'本地工作区读取未完成，请重试。':'正在读取本地工作区…'}</p>{error&&<button onClick={()=>void load()}>重试读取</button>}</main>;
  const game=settings.selectedGame;
  const navButton=(key:typeof page,label:string,icon:Parameters<typeof Icon>[0]['kind'],onClick=()=>setPage(key))=><button key={key} className={page===key?'active':''} aria-current={page===key?'page':undefined} title={sidebar.collapsed?label:undefined} aria-label={sidebar.collapsed?label:undefined} disabled={busy} onClick={onClick}><Icon kind={icon}/><span className="nav-text">{label}</span></button>;
  return <div className={`app-shell ${sidebar.collapsed?'sidebar-collapsed':''}`} style={sidebar.shellStyle}>
    <aside className="sidebar"><div className="sidebar-head"><div className="brand"><span className="brand-mark">K</span><div>ModManager<span>MOD MANAGER</span></div></div><button type="button" className="sidebar-toggle" aria-label={sidebar.collapsed?'展开侧边栏':'折叠侧边栏'} aria-expanded={!sidebar.collapsed} title={sidebar.collapsed?'展开侧边栏':'折叠侧边栏'} onClick={sidebar.toggle}><Icon kind="panel"/></button></div><div className="nav-label">游戏配置</div>
      <nav className="game-nav" aria-label="游戏配置"><label className="sr-only" htmlFor="current-game">当前游戏</label><select id="current-game" aria-label="当前游戏" className="current-game-select" value={game} disabled={busy} onChange={event=>void selectGame(event.target.value as GameId)}>{(Object.keys(GAMES) as GameId[]).map(id=><option key={id} value={id}>{GAMES[id].name} · {GAMES[id].importer}</option>)}</select></nav>
      <div className="nav-label">管理</div><nav aria-label="主要导航">{navButton('mods','Mod 库','grid',()=>{if(page!=='market'&&page!=='downloads')setScope(null);setPage('mods');})}{navButton('market','获取Mod','search',()=>{setIniId('');setPage('market');})}{navButton('downloads','下载进度','download',()=>{setIniId('');setPage('downloads');})}</nav>
      <nav className="tools-nav" aria-label="工作区工具">{navButton('conflicts','候选冲突','grid')}{navButton('recovery','备份与恢复','folder')}<button title={sidebar.collapsed?'快速管理浮窗':undefined} aria-label={sidebar.collapsed?'快速管理浮窗':undefined} disabled={busy} onClick={()=>void desktopAction(async()=>{unwrap(await window.kmm.floating(true));})}><Icon kind="grid"/><span className="nav-text">快速管理浮窗</span></button></nav>
      <nav className="sidebar-footer" aria-label="预设与设置">{navButton('presets','预设','grid')}{navButton('preferences','设置','settings')}</nav>
      {!sidebar.collapsed&&<div className="sidebar-resizer" {...sidebar.resizerProps}/>}
    </aside>
    <div className="workspace"><header className="workspace-bar"><span>{GAMES[game].name}<small>{GAMES[game].subtitle}</small></span><div className="desktop-actions"><ThemeControl/><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.launchXXMI(game,'gui').then(unwrap))}>打开 XXMI</button><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.launchXXMI(game,'game').then(unwrap))}>启动游戏</button></div></header><FeedbackNotice error={error}/><FeedbackNotice message={desktopMessage} tone={desktopTone} title={desktopTone==='warning'?'启动状态待确认':undefined}/>
      {(page==='mods'||(page==='market'||page==='downloads')&&scope)&&<div hidden={page!=='mods'}>{scope?<ModPage key={game} active={page==='mods'} initialModId={initialModId} gameId={game} scope={scope} onBack={()=>{setInitialModId('');setScope(null);}} savedRoot={settings.games[game].modsDirectory} onBusy={setBusy} onSettings={()=>setPage('preferences')} onIni={id=>{setIniTarget(null);setIniId(id);}}/>:<CharacterGallery key={game} gameId={game} savedRoot={settings.games[game].modsDirectory} onBusy={setBusy} onSettings={()=>setPage('preferences')} onOpen={setScope}/>}</div>}
      {page==='market'&&<ModBrowserPage gameId={game} onDownloads={()=>setPage('downloads')}/>}
      {page==='downloads'&&<ModDownloadsPage modsRoots={{zzz:settings.games.zzz.modsDirectory,endfield:settings.games.endfield.modsDirectory}} onBrowse={()=>{setIniId('');setPage('market');}} onLibrary={(taskGame,id)=>{void (async()=>{if(game!==taskGame&&!await selectGame(taskGame))return;setInitialModId(id);setScope({kind:'all'});setPage('mods');})();}}/>}
      <main className="business-page preferences-page" hidden={page!=='preferences'}><div className="page-heading"><div><h1>设置</h1></div></div><div className="settings-tabs" role="tablist" aria-label="设置分页" onKeyDown={event=>{if(busy||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const tabs=['general','diagnostics','about']as const;const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs[2]:tabs[(tabs.indexOf(settingsTab)+(event.key==='ArrowRight'?1:2))%3];setSettingsTab(next);document.getElementById(`settings-tab-${next}`)?.focus();}}>{([['general','常规设置'],['diagnostics','诊断'],['about','关于']]as const).map(([key,label])=><button key={key} id={`settings-tab-${key}`} role="tab" aria-selected={settingsTab===key} aria-controls={`settings-panel-${key}`} tabIndex={settingsTab===key?0:-1} className={settingsTab===key?'active':''} disabled={busy} onClick={()=>setSettingsTab(key)}>{label}</button>)}</div><div id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" hidden={settingsTab!=='general'}><section className="card settings-shortcuts" aria-labelledby="settings-shortcuts-title"><h2 id="settings-shortcuts-title">快捷操作</h2><div className="settings-shortcut-actions"><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.refreshGame(game).then(unwrap))}>请求刷新</button><button disabled={busy} onClick={()=>{setIniId('');setPage('market');}}>打开 Mod 网页</button><button disabled={busy} onClick={()=>void desktopAction(()=>window.kmm.openLink(game,'update').then(unwrap))}>打开更新发布页</button><button onClick={()=>void window.kmm.quit()}>退出管理器</button></div></section><SettingsPage key={settingsRevision} initialSettings={settings} gameId={game} hidden={page!=='preferences'||settingsTab!=='general'} onSaved={acceptSettings} onBusy={setBusy}/><CompatibilityPanel key={game} gameId={game} hidden={page!=='preferences'||settingsTab!=='general'}/><DesktopSettings hidden={page!=='preferences'||settingsTab!=='general'}/></div><div id="settings-panel-diagnostics" role="tabpanel" aria-labelledby="settings-tab-diagnostics" hidden={settingsTab!=='diagnostics'}><DiagnosticsPanel key={game} gameId={game} onNavigate={target=>{if(target==='settings'){setPage('preferences');setSettingsTab('general');}else{if(target==='mods')setScope({kind:'all'});setPage(target);}}}/></div><div id="settings-panel-about" role="tabpanel" aria-labelledby="settings-tab-about" hidden={settingsTab!=='about'}><AboutPage hidden={page!=='preferences'||settingsTab!=='about'} onBusy={setBusy}/></div></main>
      {page==='conflicts'&&<ConflictPage key={game} gameId={game} onBusy={setBusy} onMod={id=>{setInitialModId(id);setScope({kind:'all'});setPage('mods');}} onIni={target=>{if(iniId)return;setIniTarget(target);setIniId(target.modId);}}/>}
      {page==='recovery'&&<RecoveryPage key={game} gameId={game} onBusy={setBusy} onRestored={async()=>{acceptSettings(unwrap(await window.kmm.readSettings()));setSettingsRevision(value=>value+1);}}/>}
      {page==='presets'&&<BusinessPage key={`${game}-${page}`} kind={page} gameId={game} onBusy={setBusy} onRestored={async()=>{acceptSettings(unwrap(await window.kmm.readSettings()));setSettingsRevision(value=>value+1);}}/>}
      {iniId&&<IniEditor target={iniTarget||undefined} gameId={game} modId={iniId} onClose={()=>{setIniId('');setIniTarget(null);}} onBusy={setBusy}/>}
    </div>
  </div>;
}
