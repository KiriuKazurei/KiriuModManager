import {FeedbackNotice} from './Notices';
import {useState} from 'react';
import type {GameId,ModUpdateCheck} from '../shared/contracts';
import {unwrap} from './ui';
export function ModUpdatesPanel({gameId,ids,busy,onBusy}:{gameId:GameId;ids:string[];busy:boolean;onBusy:(busy:boolean)=>void}){
 const [results,setResults]=useState<ModUpdateCheck[]>([]),[error,setError]=useState(''),[message,setMessage]=useState('');
 async function check(){onBusy(true);setError('');setMessage('');try{setResults(unwrap(await window.kmm.checkModUpdates(gameId,ids)));}catch(e){setError((e as Error).message);}finally{onBusy(false);}}
 async function download(modId:string,id:string){onBusy(true);setError('');try{const result=unwrap(await window.kmm.prepareModUpdate(gameId,modId,id));if(result)setMessage('下载请求已提交，请到“下载进度”选择包内条目并确认替换。');}catch(e){setError((e as Error).message);}finally{onBusy(false);}}
 return <details className="detail-section mod-updates"><summary>Mod 更新</summary><p className="hint">手动检查来源声明和文件变化。新增文件可能是其它变体，确认前请核对文件名。</p><button disabled={busy||!ids.length} onClick={()=>void check()}>检查所选 Mod 更新</button><FeedbackNotice error={error}/><FeedbackNotice message={message}/>{results.map(result=><article key={result.modId}><p>{result.message}</p>{result.candidates.map(candidate=><div className="update-candidate" key={candidate.id}><span>{candidate.remote.fileName}<small>声明版本：{candidate.version||'未知'} · {(candidate.remote.size/1024).toFixed(1)} KiB · 文件 {candidate.remote.fileId}</small></span><button disabled={busy} onClick={()=>void download(result.modId,candidate.id)}>下载此候选</button></div>)}</article>)}</details>;
}
