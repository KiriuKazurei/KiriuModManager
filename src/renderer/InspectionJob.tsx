import {useEffect,useRef,useState} from 'react';
import {GAMES,type GameId} from '../shared/contracts';
import type {InspectionJob} from '../shared/inspections';
import {unwrap} from './ui';
export function useInspectionJob(game:GameId){
 const [job,setJob]=useState<InspectionJob|null>(null),[error,setError]=useState('');const generation=useRef(0),current=useRef<InspectionJob|null>(null);
 useEffect(()=>{current.current=job;},[job]);
 useEffect(()=>{generation.current++;setJob(null);setError('');return()=>{generation.current++;const last=current.current;if(last?.stage==='running')void window.kmm.cancelInspectionJob(last.id);current.current=null;};},[game]);
 useEffect(()=>{if(!job||job.stage!=='running')return;let active=true;const timer=setTimeout(()=>{void window.kmm.readInspectionJob(job.id).then(result=>{if(!active)return;try{const next=unwrap(result);if(next.gameId===game){setJob(next);current.current=next;}}catch(e){setError((e as Error).message);setJob(null);}});},450);return()=>{active=false;clearTimeout(timer);};},[job,game]);
 useEffect(()=>window.kmm.onDesktopChange(event=>{if(event.gameId===game)setJob(previous=>previous?{...previous,stale:true}:null);}),[game]);
 const start=async(work:()=>Promise<import('../shared/contracts').Result<InspectionJob>>)=>{const expected=++generation.current;setError('');try{const next=unwrap(await work());if(generation.current===expected&&next.gameId===game){setJob(next);current.current=next;}}catch(e){if(generation.current===expected)setError((e as Error).message);}};
 const cancel=async()=>{if(!job)return;try{setJob(unwrap(await window.kmm.cancelInspectionJob(job.id)));}catch(e){setError((e as Error).message);}};
 return {job,error,start,cancel,clear:()=>{setJob(null);setError('');},setError};
}
export function InspectionProgress({job,error,onCancel}:{job:InspectionJob|null;error:string;onCancel:()=>void}){return <div className="inspection-progress" aria-live="polite">{error&&<p className="error" role="alert">{error}</p>}{job&&<><p role="status">{job.stage==='running'?'读取中':job.stage==='complete'?'读取完成':job.stage==='canceled'?'已取消':'读取失败'}{job.progress!==({running:'读取中',complete:'读取完成',canceled:'已取消',error:'读取失败'}[job.stage])?' · '+job.progress:''}{job.stale?' · 结果已过期，请重新读取':''}</p><small>{GAMES[job.gameId].name} · {job.paths.modsDirectory||'未配置 Mod 目录'} · {new Date(job.observedAt).toLocaleString('zh-CN')}</small>{job.stage==='running'&&<button onClick={onCancel}>取消读取</button>}</>}</div>;}
