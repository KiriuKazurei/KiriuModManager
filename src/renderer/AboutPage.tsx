import {useEffect,useState} from 'react';
import {AppUpdatePanel} from './AppUpdatePanel';
import {unwrap} from './ui';
export function AboutPage({hidden,onBusy}:{hidden:boolean;onBusy:(busy:boolean)=>void}){
 const [version,setVersion]=useState('');const [error,setError]=useState('');
 useEffect(()=>{if(hidden)return;let active=true;void window.kmm.desktopStatus().then(unwrap).then(status=>{if(active){setVersion(status.version);setError('');}}).catch(error=>{if(active)setError(error.message);});return()=>{active=false;};},[hidden]);
 return <><section className="card about-app" aria-labelledby="about-app-title"><span className="brand-mark" aria-hidden="true">K</span><div><h2 id="about-app-title">Kiriu Mod Manager</h2><p className="about-version">版本 <strong>{version||'读取中'}</strong></p></div>{error&&<p className="error" role="alert">{error}</p>}</section><AppUpdatePanel hidden={hidden} onBusy={onBusy}/></>;
}
