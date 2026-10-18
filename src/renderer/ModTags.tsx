import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import type {GameId,LibrarySnapshot,ModEntry} from '../shared/contracts';
import {normalizeTags} from '../shared/mod-library';
import {DEFAULT_TAG_COLOR,tagTextColor} from '../shared/mod-tags';
import {unwrap} from './ui';
import {FeedbackNotice} from './Notices';

const tagStyle=(color:string):CSSProperties=>({'--tag-bg':color,'--tag-fg':tagTextColor(color)} as CSSProperties);
function showPopover(node:HTMLElement,x:number,y:number){
 node.showPopover();const bounds=node.getBoundingClientRect();
 node.style.left=Math.max(12,Math.min(x,innerWidth-bounds.width-12))+'px';
 node.style.top=Math.max(12,Math.min(y,innerHeight-bounds.height-12))+'px';
}

export function ModTagList({mod}:{mod:ModEntry}){
 const tags=mod.tags||[],colors=mod.tagColors||{},container=useRef<HTMLDivElement>(null),measure=useRef<HTMLSpanElement>(null),popup=useRef<HTMLDivElement>(null);
 const [visible,setVisible]=useState(tags.length),signature=JSON.stringify([tags,colors]);
 useLayoutEffect(()=>{
  const node=container.current,probe=measure.current;if(!node||!probe)return;
  const update=()=>{
   const widths=Array.from(probe.children,child=>child.getBoundingClientRect().width),available=node.clientWidth;
   if(widths.reduce((sum,width)=>sum+width,0)+Math.max(0,widths.length-1)*6<=available){setVisible(widths.length);return;}
   let used=0,count=0;for(const width of widths){if(used+width+6+28>available)break;used+=width+6;count++;}setVisible(count);
  };
  const observer=new ResizeObserver(update);observer.observe(node);observer.observe(probe);update();return()=>observer.disconnect();
 },[signature]);
 if(!tags.length)return null;
 const chip=(name:string)=><span className="mod-tag" key={name} style={tagStyle(colors[name]||DEFAULT_TAG_COLOR)}>{name}</span>;
 return <div className="mod-tag-list" ref={container}>
  <span className="tag-measure" ref={measure} aria-hidden="true">{tags.map(chip)}</span>
  {tags.slice(0,visible).map(chip)}
  {visible<tags.length&&<button type="button" className="tag-overflow" aria-label={`展开${mod.name}的全部标签`} title="展开全部标签" onClick={event=>{event.stopPropagation();const box=event.currentTarget.getBoundingClientRect();if(popup.current)showPopover(popup.current,box.left,box.bottom+6);}}>…</button>}
  <div ref={popup} popover="auto" role="dialog" aria-label={`${mod.name}的全部标签`} className="tag-popover tag-expanded"><strong>全部标签</strong><div className="tag-chips">{tags.map(chip)}</div></div>
 </div>;
}

function TagEditor({name,color,x,y,busy,onClose,onSave,onDelete}:{name:string;color:string;x:number;y:number;busy:boolean;onClose:()=>void;onSave:(name:string,color:string)=>Promise<boolean>;onDelete:()=>Promise<boolean>}){
 const [draft,setDraft]=useState(name),[background,setBackground]=useState(color),popup=useRef<HTMLDivElement>(null),nameInput=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(popup.current){showPopover(popup.current,x,y);nameInput.current?.focus();}},[]);
 return <div ref={popup} popover="auto" role="dialog" aria-label={`编辑标签 ${name}`} className="tag-popover tag-editor" onToggle={event=>{if((event.nativeEvent as ToggleEvent).newState==='closed')onClose();}}>
  <form onSubmit={event=>{event.preventDefault();void onSave(draft,background).then(saved=>{if(saved)onClose();});}}>
   <h3>编辑标签</h3><label htmlFor="edit-tag-name">标签名称</label><input ref={nameInput} id="edit-tag-name" value={draft} maxLength={40} disabled={busy} onChange={event=>setDraft(event.target.value)}/>
   <label htmlFor="edit-tag-color">标签背景色</label><input id="edit-tag-color" type="color" value={background} disabled={busy} onChange={event=>setBackground(event.target.value)}/>
   <div className="tag-editor-actions"><button type="submit" className="primary" disabled={busy||!draft.trim()}>保存标签</button><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="danger" disabled={busy} onClick={()=>void onDelete().then(saved=>{if(saved)onClose();})}>删除标签</button></div>
  </form>
 </div>;
}

export function ModTagsPanel({gameId,mod,busy,onBusy,onUpdated}:{gameId:GameId;mod:ModEntry;busy:boolean;onBusy:(busy:boolean)=>void;onUpdated:(library:LibrarySnapshot)=>void}){
 const tags=mod.tags||[],colors=mod.tagColors||{};
 const [name,setName]=useState(''),[color,setColor]=useState(DEFAULT_TAG_COLOR),[error,setError]=useState('');
 const [editor,setEditor]=useState<{name:string;color:string;x:number;y:number}|null>(null);
 async function save(values:string[],nextColors:Record<string,string>){
  onBusy(true);setError('');
  try{onUpdated(unwrap(await window.kmm.operateMod(gameId,mod.id,{kind:'tags',values,colors:nextColors})));return true;}
  catch(error){setError((error as Error).message);return false;}
  finally{onBusy(false);}
 }
 function unique(value:string,except?:string){const normalized=normalizeTags([value])[0];if(tags.some(tag=>tag!==except&&tag.toLocaleLowerCase()===normalized.toLocaleLowerCase()))throw new Error('已有同名标签。');return normalized;}
 async function add(){try{const tag=unique(name);if(await save([...tags,tag],{...colors,[tag]:color}))setName('');}catch(error){setError((error as Error).message);}}
 async function rename(value:string,background:string){
  if(!editor)return false;
  try{const next=unique(value,editor.name),values=tags.map(tag=>tag===editor.name?next:tag),nextColors=Object.fromEntries(values.map(tag=>[tag,tag===next?background:colors[tag]||DEFAULT_TAG_COLOR]));return await save(values,nextColors);}
  catch(error){setError((error as Error).message);return false;}
 }
 async function remove(){if(!editor)return false;const values=tags.filter(tag=>tag!==editor.name);return save(values,Object.fromEntries(values.map(tag=>[tag,colors[tag]||DEFAULT_TAG_COLOR])));}
 function open(tag:string,x:number,y:number){setError('');setEditor({name:tag,color:colors[tag]||DEFAULT_TAG_COLOR,x,y});}
 return <section className="mod-tags-panel" aria-label="Mod 标签">
  <h3>标签</h3><div className="tag-chips detail-tags">{tags.map(tag=><button type="button" className="mod-tag" key={tag} style={tagStyle(colors[tag]||DEFAULT_TAG_COLOR)} disabled={busy} aria-label={`编辑标签 ${tag}`} title="右键编辑标签" onClick={event=>{const box=event.currentTarget.getBoundingClientRect();open(tag,box.left,box.bottom+6);}} onContextMenu={event=>{event.preventDefault();open(tag,event.clientX,event.clientY);}} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();const box=event.currentTarget.getBoundingClientRect();open(tag,box.left,box.bottom+6);}}}>{tag}</button>)}</div>
  <form className="tag-add-form" onSubmit={event=>{event.preventDefault();void add();}}><label htmlFor="mod-tags">添加标签</label><div className="tag-add-controls"><input id="mod-tags" value={name} maxLength={40} placeholder="输入标签名称" disabled={busy} onChange={event=>setName(event.target.value)}/><input type="color" aria-label="新标签背景色" value={color} disabled={busy} onChange={event=>setColor(event.target.value)}/><button type="submit" disabled={busy||!name.trim()}>添加</button></div></form>
  <FeedbackNotice error={error}/>
  {tags.length>0&&<p className="tag-help">右键标签可重命名、改色或删除。</p>}
  {editor&&<TagEditor key={editor.name} {...editor} busy={busy} onClose={()=>setEditor(null)} onSave={rename} onDelete={remove}/>}
 </section>;
}
