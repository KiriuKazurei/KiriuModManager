import type {RendererLogEvent} from '../shared/logging';
let installed=false;
export function reportRendererEvent(event:RendererLogEvent){void window.kmm.reportRendererEvent(event).catch(()=>{});}
export function rendererError(kind:'error'|'unhandled-rejection'|'react-error',error:unknown,control?:string){reportRendererEvent({kind,control,message:(error instanceof Error?error.message:typeof error==='string'?error:'Unknown renderer error').slice(0,6000),...(error instanceof Error&&error.stack?{stack:error.stack.slice(0,6000)}:{})});}
export function installRendererLogging(){
 if(installed)return;installed=true;
 window.addEventListener('error',event=>rendererError('error',event.error||event.message));
 window.addEventListener('unhandledrejection',event=>rendererError('unhandled-rejection',event.reason));
 document.addEventListener('click',event=>{
  const target=event.target instanceof Element?event.target.closest('button,summary,a,[role="tab"]'):null;if(!target)return;
  // Record the control, never text input, file paths or dynamic Mod names.
  const fixed=new Set(['设置','诊断','关于','Mod 库','获取Mod','下载进度','候选冲突','备份与恢复','预设','保存配置','开始检查','重新检查','打开日志目录','分析日志','刷新日志分析']);
  const label=target.textContent?.trim()||'',control=target.tagName.toLowerCase()+':'+(target.id||target.getAttribute('data-log-action')||(fixed.has(label)?label:(target.getAttribute('class')||'control').split(' ').slice(0,2).join('.')));
  reportRendererEvent({kind:'action',control:control.slice(0,160)});
 },true);
 document.addEventListener('change',event=>{const target=event.target;if(target instanceof HTMLInputElement||target instanceof HTMLSelectElement||target instanceof HTMLTextAreaElement)reportRendererEvent({kind:'action',control:('change:'+(target.id||target.name||target.tagName)).slice(0,160)});},true);
}
