import { Result } from '../shared/contracts';
export function unwrap<T>(result:Result<T>):T {if(!result.ok) throw new Error(result.error); return result.value;}
export function OperationFeedback({error,message,quiet}:{error:string;message:string;quiet:string}){
  return <div className="feedback" aria-live="polite">{message?<p className="success">{message}</p>:null}{error?<p className="error" role="alert">{error}</p>:null}{!message&&!error?<p className="quiet">{quiet}</p>:null}</div>;
}
export function Icon({kind}:{kind:'settings'|'game'|'folder'|'grid'|'search'|'plus'|'panel'}) {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kind==='panel'?<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>:kind==='folder'?<path d="M3 7h7l2 2h9v11H3V7Zm0 0V4h7l2 3"/>:kind==='game'?<><rect x="3" y="6" width="18" height="13" rx="4"/><path d="M7 12h4M9 10v4M16 11h.01M18 14h.01"/></>:kind==='grid'?<><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>:kind==='search'?<><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></>:kind==='plus'?<path d="M12 4v16M4 12h16"/>:<><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></>}</svg>;
}
