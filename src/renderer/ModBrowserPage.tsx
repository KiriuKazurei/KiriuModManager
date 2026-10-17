import {FeedbackNotice,useNoticeOpen} from './Notices';
import {useEffect,useRef,useState} from 'react';
import type {GameId,ModBrowserStatus} from '../shared/contracts';
import {GAMES,MOD_MARKET_URLS} from '../shared/contracts';
import {Icon,unwrap} from './ui';
export function ModBrowserPage({gameId,onDownloads}:{gameId:GameId;onDownloads:()=>void}){
 const viewport=useRef<HTMLDivElement>(null);const [status,setStatus]=useState<ModBrowserStatus|null>(null);const [error,setError]=useState('');
 const supported=!!MOD_MARKET_URLS[gameId];const noticeOpen=useNoticeOpen(),noticeRef=useRef(noticeOpen),relayout=useRef<()=>void>(()=>{});noticeRef.current=noticeOpen;
 useEffect(()=>{
  setStatus(null);setError('');
  let active=true;let frame=0;let polling=false;
  const accept=(value:ModBrowserStatus)=>{if(active&&value.gameId===gameId)setStatus(value);};
  const failed=(e:Error)=>{if(active)setError(e.message);};
  const layout=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const rect=viewport.current?.getBoundingClientRect();void window.kmm.setModBrowser(gameId,supported&&!noticeRef.current&&rect?{x:rect.x,y:rect.y,width:rect.width,height:rect.height}:null).then(unwrap).then(accept).catch(failed);});};
  const poll=async()=>{if(polling)return;polling=true;try{accept(unwrap(await window.kmm.modBrowserStatus()));}catch(e){failed(e as Error);}finally{polling=false;}};
  relayout.current=layout;const observer=new ResizeObserver(layout);if(viewport.current)observer.observe(viewport.current);
  window.addEventListener('resize',layout);window.addEventListener('scroll',layout,true);layout();void poll();const timer=setInterval(()=>void poll(),600);
  return()=>{active=false;clearInterval(timer);observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',layout);window.removeEventListener('scroll',layout,true);void window.kmm.setModBrowser(gameId,null);};
 },[gameId,supported]);
 useEffect(()=>{relayout.current();},[noticeOpen]);
 async function navigate(action:'back'|'forward'|'reload'|'home'|'external'){setError('');try{setStatus(unwrap(await window.kmm.navigateModBrowser(action)));}catch(e){setError((e as Error).message);}}
 const activeDownloads=status?.downloads.filter(task=>['binding','downloading','verifying'].includes(task.stage)).length||0;
 return <main className="market-page" aria-label="获取 Mod"><h1 className="sr-only">获取Mod</h1>
  {supported&&<div className="browser-toolbar" role="toolbar" aria-label="浏览器工具栏">
   <button aria-label="网页后退" title="后退" disabled={!status?.canGoBack} onClick={()=>void navigate('back')}><Icon kind="back"/></button>
   <button aria-label="网页前进" title="前进" disabled={!status?.canGoForward} onClick={()=>void navigate('forward')}><Icon kind="forward"/></button>
   <button aria-label="刷新网页" title="刷新" onClick={()=>void navigate('reload')}><Icon kind="refresh"/></button>
   <button aria-label={`${GAMES[gameId].name}主页`} title={`${GAMES[gameId].name}主页`} onClick={()=>void navigate('home')}><Icon kind="home"/></button>
   <div className="browser-address"><span className={status?.loading?'browser-loading':'browser-site-indicator'} aria-hidden="true"/><input aria-label="网页地址" readOnly value={status?.url||MOD_MARKET_URLS[gameId]} onFocus={event=>event.currentTarget.select()}/>{status?.loading&&<span className="sr-only" role="status">网页载入中</span>}</div>
   <button aria-label="查看下载进度" title={activeDownloads?`${activeDownloads} 项下载中`:'下载进度'} onClick={onDownloads}><Icon kind="download"/>{activeDownloads>0&&<span className="browser-download-count">{activeDownloads}</span>}</button>
  </div>}
  <FeedbackNotice error={error||status?.error}/>
  {status?.externalUrl&&<div className="market-external"><code>{status.externalUrl}</code><button onClick={()=>void navigate('external')}>打开外部链接</button></div>}
  {supported?<div className="market-viewport" ref={viewport} aria-label="GameBanana 内置浏览器"><p className="mod-business-note">正在显示 GameBanana 网页；网页不可用时可通过工具栏刷新。</p></div>:<div className="empty-state"><h2>{GAMES[gameId].name}尚未指定 Mod 网页</h2><p>切换到绝区零即可浏览 GameBanana。</p></div>}
 </main>;
}
