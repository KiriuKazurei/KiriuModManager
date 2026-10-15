import { useEffect, useState } from 'react';
import { GAMES, GameId, GamePaths, Settings, Inspection, Result, DeploymentProgress, DeploymentResult, RuntimeStatus } from '../shared/contracts';
import {acceptSubmittedGamePaths,dirtyPatch,gameDraftDirty,rebaseSettingsDraft,settingsForGame,SettingsDraft} from './settings-draft';
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw new Error(result.error); return result.value; }
function Icon({ kind }: { kind: 'settings' | 'game' | 'folder' }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'folder' ? <path d="M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3" /> : kind === 'game' ? <><rect x="3" y="6" width="18" height="13" rx="4"/><path d="M7 12h4M9 10v4M16 11h.01M18 14h.01"/></> : <><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></>}
  </svg>;
}
export function SettingsPage({ initialSettings, gameId: selectedGame, hidden, onSaved, onBusy }: { initialSettings:Settings; gameId:GameId; hidden:boolean; onSaved:(settings:Settings)=>void; onBusy:(busy:boolean)=>void }) {
  const [configuration,setConfiguration] = useState<SettingsDraft>({draft:initialSettings,baseline:initialSettings});
  const settings=configuration.draft;
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [progress, setProgress] = useState<DeploymentProgress | null>(null);
  const [deployment, setDeployment] = useState<DeploymentResult | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  useEffect(()=>{setConfiguration(previous=>rebaseSettingsDraft(previous,initialSettings));},[initialSettings]);
  useEffect(() => {
    setInspection(null); setDeployment(null); setProgress(null); setMessage(''); setError('');
  }, [selectedGame]);
  useEffect(()=>onBusy(busy),[busy,onBusy]);
  useEffect(() => {
    if (!deploying) return;
    const timer = setInterval(() => { void window.kmm.deploymentProgress().then(result => { if (result.ok) setProgress(result.value); }); }, 400);
    return () => clearInterval(timer);
  }, [deploying]);
  async function action(work: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const gameId = selectedGame;
  const game = GAMES[gameId];
  const fields = settings.games[gameId];
  const dirty = gameDraftDirty(configuration,gameId);
  useEffect(()=>{
    const normalize=(value:string)=>value.trim().replace(/\\/g,'/').replace(/\/+$/,'').toLowerCase();
    if(inspection&&(inspection.gameId!==gameId||normalize(inspection.xxmiRoot)!==normalize(fields.xxmiRoot))){setInspection(null);setDeployment(null);setProgress(null);setMessage('');}
  },[inspection,gameId,fields.xxmiRoot]);
  function update(field: keyof GamePaths, value: string) {
    setConfiguration(previous=>({...previous,draft:{...previous.draft,games:{...previous.draft.games,[gameId]:{...previous.draft.games[gameId],[field]:value}}}}));
    if (field === 'xxmiRoot') setInspection(null);
    setMessage(''); setError('');
    setDeployment(null);
  }
  const detect = async () => {
    const found = unwrap(await window.kmm.inspect(gameId, fields.xxmiRoot)); setInspection(found);
    setMessage('检测完成。识别结果尚未保存，可检查后使用识别路径。');
  };
  const save = async () => {
    const game = gameId;
    const submitted = dirtyPatch(configuration.draft.games[game], configuration.baseline.games[game]);
    if (!Object.keys(submitted).length) { setMessage('无待保存更改'); return; }
    const data = unwrap(await window.kmm.saveGamePaths(game, submitted));
    setConfiguration(previous=>acceptSubmittedGamePaths(previous,data,game,submitted)); onSaved(data);
    setMessage('配置已保存，重启后会恢复当前游戏和路径。');
  };
  const deploy = async () => {
    setDeploying(true); setDeployment(null); setProgress({ stage: 'resolve', message: '准备读取官方发行信息…', percent: 0 });
    try {
      const result = unwrap(await window.kmm.deploy(settingsForGame(configuration,unwrap(await window.kmm.readSettings()),gameId)));
      setDeployment(result); setConfiguration(previous=>rebaseSettingsDraft(previous,result.settings,gameId)); onSaved(result.settings); setInspection(result.inspection); setRuntime(result.runtime);
      setProgress(unwrap(await window.kmm.deploymentProgress()));
      setMessage(result.ready ? '官方组件与路径部署完成，配置已保存。游戏内加载仍需通过 XXMI 验证。' : '官方组件与路径已部署并保存。请先安装或确认 Visual C++ x64 运行库。');
    } finally {
      const status = await window.kmm.deploymentProgress(); if (status.ok) setProgress(status.value);
      setDeploying(false);
    }
  };
  const sync = async () => {
    const result = unwrap(await window.kmm.syncPaths(settingsForGame(configuration,unwrap(await window.kmm.readSettings()),gameId))); setConfiguration(previous=>rebaseSettingsDraft(previous,result.settings,gameId)); onSaved(result.settings); setInspection(result.inspection);
    setMessage(`路径已同步到 XXMI 并保存。原配置备份：${result.backupDirectory}`);
  };
  return <div className="settings-page" hidden={hidden}>
      <div id="settings-main"><div className="page-heading"><div><h2>路径与加载器</h2></div><span className={`save-state ${dirty ? 'unsaved' : ''}`}>{dirty ? '有未保存的更改' : '配置已同步'}</span></div>
      <section className="card" aria-labelledby="paths-title"><div className="section-heading"><Icon kind="folder"/><div><h2 id="paths-title">{game.name} · 目录设置</h2><p>每款游戏分别保存路径，切换游戏不会覆盖另一工作区。</p></div></div>
        <form onSubmit={event => { event.preventDefault(); void action(save); }}>
          {([
            ['xxmiRoot', 'XXMI 安装根目录', '选择外层根目录，其中应包含 Resources\\Bin\\XXMI Launcher.exe。'],
            ['gameDirectory', '游戏目录', '已安装游戏的位置。“保存配置”只保存本机设置；部署或同步会配置 XXMI。'],
            ['modsDirectory', 'Mod 目录', '默认在管理器目录下按游戏分开保存：Mods/ZZZ 或 Mods/Endfield。可选择其它目录；保存不会改写 loader，需使用“同步路径到 XXMI”接入。'],
          ] as const).map(([field, label, hint]) => <div className="field" key={field}><label htmlFor={field}>{label}</label><div className="path-control"><input id={field} name={field} value={fields[field]} placeholder="选择目录或输入完整路径" onChange={event => update(field, event.target.value)} disabled={busy} aria-describedby={`${field}-hint`} spellCheck={false}/><button type="button" disabled={busy} aria-label={`选择${label}`} onClick={() => void action(async () => { const selected = unwrap(await window.kmm.chooseDirectory(fields[field])); if (selected) update(field, selected); })}><Icon kind="folder"/>选择目录</button></div><p id={`${field}-hint`} className="hint">{hint}</p></div>)}
          <div className="form-actions"><button type="button" disabled={busy || !fields.xxmiRoot.trim()} onClick={() => void action(detect)}>{busy ? '正在处理…' : '检测已有安装'}</button><button type="submit" className="primary" disabled={busy || !dirty}>保存配置</button></div>
        </form>
      </section>
      <div className="feedback" aria-live="polite" aria-atomic="true">{error ? <p className="error" role="alert">{error}</p> : message ? <p className="success">{message}</p> : <p className="quiet">{dirty ? '请保存更改，当前路径仅在本次窗口中生效。' : '配置保存在本机，可随时重新检测安装。'}</p>}</div>
      <details className="card deploy-card" aria-labelledby="deploy-title"><summary className="section-heading"><Icon kind="folder"/><div><h2 id="deploy-title">新用户 · 自动部署 XXMI</h2><p>需要安装加载器时展开，已有用户可直接检测与同步。</p></div></summary>
        <p className="operation-hint">请指定空的 XXMI 安装目录和已安装的游戏目录。部署会写入所选安装位置，创建 Mod 目录并保存设置，不启动游戏。已有安装请使用下方路径同步。</p>
        <div className="deploy-actions"><button type="button" className="primary" disabled={busy || !fields.xxmiRoot.trim() || !fields.gameDirectory.trim()} onClick={() => void action(deploy)}>{deploying ? '正在部署…' : `下载并部署 ${game.importer}`}</button><button type="button" disabled={busy} onClick={() => void action(async () => { const value = unwrap(await window.kmm.checkRuntime()); setRuntime(value); setDeployment(previous => previous && ({ ...previous, runtime: value, ready: value.installed })); })}>检查运行库</button></div>
        {progress && <div className={`deployment-progress ${progress.stage === 'error' ? 'error' : ''}`} aria-live="polite"><div><span>{progress.message}</span><span>{progress.percent}%</span></div><progress max="100" value={progress.percent} aria-label="XXMI 部署进度"/>{progress.totalBytes && <small>{((progress.bytes || 0) / 1048576).toFixed(1)} / {(progress.totalBytes / 1048576).toFixed(1)} MB</small>}</div>}
        {deployment && <div className="deployment-result"><p><strong>文件部署完成</strong> · {Object.entries(deployment.versions).map(([name, version]) => `${name} ${version}`).join(' / ')}</p><p>{deployment.ready ? '运行库已检测；可通过 XXMI 检查游戏加载。' : '运行库待确认；尚不能确认 Launcher 可启动。'}</p></div>}
        {runtime && <div className={`runtime-status ${runtime.installed ? '' : 'missing'}`}><p>{runtime.message}</p>{!runtime.installed && <p>点击下载按钮后，在浏览器中下载并运行 Microsoft 官方 x64 安装器；完成后点击“检查运行库”。</p>}<button type="button" disabled={busy} onClick={() => void action(async () => unwrap(await window.kmm.openRuntimeDownload()))}>下载 Microsoft 官方运行库</button></div>}
      </details>
      <section className="card detection" aria-labelledby="detect-title"><div className="section-heading"><Icon kind="settings"/><div><h2 id="detect-title">已有安装状态</h2><p>只读检查 Launcher、{game.importer} 组件和实际递归读取目录。</p></div><span className={`badge ${inspection?.installed ? 'good' : ''}`}>{inspection ? inspection.installed ? '检测到组件' : '未安装 / 不完整' : '尚未检测'}</span></div>
      {inspection ? <>
        <dl className="result-grid"><dt>Launcher</dt><dd>{inspection.launcherExists ? '已找到' : '未找到'}<code>{inspection.launcherPath}</code></dd><dt>{game.importer} 组件</dt><dd>{inspection.importerExists ? '目录存在' : '未安装'}<code>{inspection.importerDirectory}</code></dd><dt>游戏目录</dt><dd><code>{inspection.gameDirectory || '未配置'}</code></dd><dt>loader 读取目录</dt><dd>{inspection.modsDirectories.length ? inspection.modsDirectories.map((directory, index) => <div className="detected-mod" key={directory}><code>{directory}</code><span>{inspection.modsExist[index] ? '目录存在' : '目录不存在'}</span><button type="button" disabled={busy} onClick={() => update('modsDirectory', directory)}>使用此 Mod 目录</button></div>) : '无法确认'}</dd></dl>
        {inspection.warnings.length > 0 && <ul className="warnings">{inspection.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        {fields.modsDirectory && inspection.modsDirectories.length > 0 && !inspection.modsDirectories.some(directory => directory.toLowerCase().replace(/\\/g, '/') === fields.modsDirectory.toLowerCase().replace(/\\/g, '/')) && <p className="mismatch">当前 Mod 目录与 loader 读取目录不一致。保存配置不会同步 XXMI，请使用识别目录或自行检查 loader。</p>}
        <div className="sync-actions"><button type="button" disabled={busy || !inspection.installed} onClick={() => {
          setConfiguration(previous=>({...previous,draft:{...previous.draft,games:{...previous.draft.games,[gameId]:{...previous.draft.games[gameId],gameDirectory:inspection.gameDirectory||previous.draft.games[gameId].gameDirectory,modsDirectory:inspection.modsDirectories.length===1?inspection.modsDirectories[0]:previous.draft.games[gameId].modsDirectory}}}}));
          setMessage('已填入识别路径，请点击保存配置。');
        }}>使用识别的游戏与 Mod 路径</button><button type="button" disabled={busy || !inspection.installed || !fields.gameDirectory.trim() || !fields.modsDirectory.trim()} onClick={() => void action(sync)}>同步路径到 XXMI</button></div>
        <p className="operation-hint">同步会更新所选游戏路径与首个递归 Mod 读取目录，并保存对应 Launcher 覆盖设置。其它读取目录与游戏配置保留；原文件备份在安装目录的 .kmm-backups 下。</p>
      </> : <div className="empty-state"><Icon kind="folder"/><p>选择 XXMI 根目录后，点击“检测已有安装”。</p><small>检测只读；保存配置不会修改外部安装。加载与注入由 XXMI 完成。</small></div>}
      </section></div>
  </div>;
}

