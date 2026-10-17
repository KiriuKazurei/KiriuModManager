import {useEffect,useRef,useSyncExternalStore} from 'react';
import {notices,showNotice,confirmNotice,type NoticeTone} from './notice-store';
export {showNotice,confirmNotice} from './notice-store';
export const noticeAPI=Object.freeze({show:showNotice,confirm:confirmNotice});
declare global {interface Window {kmmNotice:typeof noticeAPI}}
export function useNoticeOpen(){return !!useSyncExternalStore(notices.subscribe,notices.current);}
export function FeedbackNotice({error,message,tone='success',title}:{error?:string;message?:string;tone?:NoticeTone;title?:string}){
 useEffect(()=>{if(error||message)void showNotice({tone:error?'error':tone,message:error||message!,detail:error&&message?message:undefined,title}).catch(()=>{});},[error,message,tone,title]);return null;
}
export function NoticeHost(){
 const notice=useSyncExternalStore(notices.subscribe,notices.current),dialog=useRef<HTMLDialogElement>(null),restore=useRef<HTMLElement|null>(null),lastFocus=useRef<HTMLElement|null>(null);
 useEffect(()=>{const track=(event:Event)=>{const element=event.target;if(element instanceof HTMLElement&&element!==document.body&&!element.closest('.notice-dialog'))lastFocus.current=element;};document.addEventListener('focusin',track,true);return()=>document.removeEventListener('focusin',track,true);},[]);
 const open=!!notice;
 useEffect(()=>{if(!open)return;const previous=document.documentElement.style.overflow;document.documentElement.style.overflow='hidden';return()=>{document.documentElement.style.overflow=previous;};},[open]);
 useEffect(()=>{
  const element=dialog.current;if(!element||!notice)return;
  if(!element.open){const active=document.activeElement;restore.current=active instanceof HTMLElement&&active!==document.body?active:lastFocus.current;element.showModal();}
  element.querySelector('.notice-body')?.scrollTo(0,0);
  element.querySelectorAll<HTMLButtonElement>('button')[notice.defaultButton]?.focus();
 },[notice]);
 useEffect(()=>{if(notice)return;const previous=restore.current;restore.current=null;if(previous?.isConnected){const target=previous.matches(':disabled')?previous.closest('form')?.querySelector<HTMLElement>('input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)'):previous;target?.focus();}},[notice]);
 if(!notice)return null;
 const choose=(button:number)=>notices.choose(notice.id,button);
 return <dialog ref={dialog} className={'notice-dialog '+notice.tone} role={notice.tone==='error'||notice.tone==='warning'?'alertdialog':'dialog'} aria-modal="true" aria-labelledby="notice-title" aria-describedby="notice-message" onCancel={event=>{event.preventDefault();choose(notice.cancelButton);}}>
  <div className="notice-heading"><span className="notice-symbol" aria-hidden="true">{notice.tone==='success'?'✓':notice.tone==='info'?'i':'!'}</span><h2 id="notice-title">{notice.title}</h2></div>
  <div className="notice-body"><p id="notice-message">{notice.message}</p>{notice.detail&&<p className="notice-detail">{notice.detail}</p>}</div>
  <div className="notice-actions">{notice.buttons.map((label,index)=><button key={index} type="button" className={index===notice.buttons.length-1?'primary':''} onClick={()=>choose(index)}>{label}</button>)}</div>
 </dialog>;
}
