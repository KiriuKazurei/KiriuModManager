import {useEffect,useState} from 'react';
import type {GameId,LibrarySnapshot,ModEntry,ModProvenanceFields} from '../shared/contracts';
import {editableProvenance} from '../shared/mod-provenance';
import {rebaseProvenanceDraft} from './mod-provenance-draft';
import {unwrap,OperationFeedback} from './ui';
const verificationLabels={unverified:'待验证',verified:'人工已验证',broken:'已失效'};
export function ModProvenancePanel({gameId,mod,busy,onBusy,onUpdated}:{gameId:GameId;mod:ModEntry;busy:boolean;onBusy:(busy:boolean)=>void;onUpdated:(library:LibrarySnapshot)=>void}) {
 const identity=`${gameId}:${mod.id}`;const [draft,setDraft]=useState(()=>rebaseProvenanceDraft(undefined,identity,editableProvenance(mod.provenance)));const [message,setMessage]=useState('');const [error,setError]=useState('');
 useEffect(()=>setDraft(previous=>rebaseProvenanceDraft(previous,identity,editableProvenance(mod.provenance))),[identity,mod.provenance]);
 function edit<K extends keyof ModProvenanceFields>(field:K,value:ModProvenanceFields[K]){setDraft(previous=>({...previous,fields:{...previous.fields,[field]:value}}));setMessage('');setError('');}
 async function save(){const submitted={...draft.fields};onBusy(true);setMessage('');setError('');try{const library=unwrap(await window.kmm.operateMod(gameId,mod.id,{kind:'provenance',fields:submitted}));const saved=library.mods.find(item=>item.id===mod.id);if(saved)setDraft(previous=>rebaseProvenanceDraft(previous,identity,editableProvenance(saved.provenance),submitted));onUpdated(library);setMessage('来源与版本记录已保存。');}catch(e){setError((e as Error).message);}finally{onBusy(false);}}
 return <details className="detail-section provenance-panel"><summary>来源与版本记录</summary>
  <p className="mod-business-note">导入时间：{mod.provenance.importedAt?new Date(mod.provenance.importedAt).toLocaleString('zh-CN'):'未知（旧库或外部加入）'}。验证状态由你手动记录。</p>
  {mod.remote&&<details className="remote-mod-info"><summary>GameBanana 网站信息</summary><dl><dt>站点标题</dt><dd>{mod.remote.title}</dd><dt>作者 / 提交者</dt><dd>{mod.remote.author||'未提供'}</dd><dt>原分类</dt><dd>{mod.remote.category||'未提供'}</dd><dt>站点身份</dt><dd>Mod {mod.remote.modId} / 文件 {mod.remote.fileId}</dd><dt>原文件</dt><dd>{mod.remote.fileName}</dd><dt>文件大小</dt><dd>{(mod.remote.size/1024**2).toFixed(1)} MiB</dd><dt>文件摘要</dt><dd>{mod.remote.checksum?`${mod.remote.checksumAlgorithm.toUpperCase()} ${mod.remote.checksum}`:'网站未提供'}</dd><dt>站点简介</dt><dd>{mod.remote.description||'未提供'}</dd></dl></details>}
  <form onSubmit={e=>{e.preventDefault();void save();}}>
   <label htmlFor="mod-source-url">来源链接</label><input id="mod-source-url" type="url" value={draft.fields.sourceUrl} disabled={busy} onChange={e=>edit('sourceUrl',e.target.value)} placeholder="https://…（可留空）"/>
   <label htmlFor="mod-version">Mod 版本</label><input id="mod-version" maxLength={120} value={draft.fields.version} disabled={busy} onChange={e=>edit('version',e.target.value)}/>
   <label htmlFor="mod-game-version">适用游戏版本</label><input id="mod-game-version" maxLength={120} value={draft.fields.gameVersion} disabled={busy} onChange={e=>edit('gameVersion',e.target.value)}/>
   <label htmlFor="mod-verification">验证状态</label><select id="mod-verification" value={draft.fields.verification} disabled={busy} onChange={e=>edit('verification',e.target.value as ModProvenanceFields['verification'])}>{Object.entries(verificationLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>
   <button disabled={busy}>保存来源与版本</button><button type="button" disabled={busy||!mod.provenance.sourceUrl} onClick={()=>{onBusy(true);setError('');setMessage('');void window.kmm.openModSource(gameId,mod.id).then(result=>setMessage(unwrap(result))).catch(e=>setError(e.message)).finally(()=>onBusy(false));}}>打开已保存来源</button>
  </form>
  <OperationFeedback error={error} message={message} quiet="替换内容后版本和验证状态会重置；上一版信息保留在历史中。"/>
  <details className="version-history"><summary>版本历史（{mod.provenance.history.length}）</summary>{[...mod.provenance.history].reverse().map((item,index)=><article key={`${item.changedAt}:${index}`}><strong>{item.version||'未填写版本'} · {verificationLabels[item.verification]}</strong><p>{item.reason==='replaced'?'内容替换前':'信息编辑前'} · {new Date(item.changedAt).toLocaleString('zh-CN')}</p><p>适用游戏：{item.gameVersion||'未填写'}</p>{item.sourceUrl&&<p className="history-source">{item.sourceUrl}</p>}</article>)}</details>
 </details>;
}
