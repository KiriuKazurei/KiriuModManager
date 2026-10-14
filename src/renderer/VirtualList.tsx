import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';

export function VirtualList<T>({items,rowHeight,className,selectedKey,itemKey,render,empty,preserveAnchor=false}:{items:T[];rowHeight:number;className:string;selectedKey?:string;itemKey:(item:T)=>string;render:(item:T)=>ReactNode;empty?:ReactNode;preserveAnchor?:boolean}){
 const viewport=useRef<HTMLDivElement>(null);const [position,setPosition]=useState({top:0,height:500});const virtual=items.length>160;
 const keys=items.map(itemKey).join('\0');
 useEffect(()=>{const node=viewport.current;if(!node)return;const resize=()=>setPosition({top:node.scrollTop,height:node.clientHeight||500});const observer=new ResizeObserver(resize);observer.observe(node);resize();return()=>observer.disconnect();},[]);
 const previous=useRef<string[]>([]),lastSelected=useRef<string|undefined>(undefined);
 useLayoutEffect(()=>{const node=viewport.current;if(!node)return;const old=previous.current;const anchor=old[Math.floor(node.scrollTop/rowHeight)],offset=node.scrollTop%rowHeight;const next=items.map(itemKey);previous.current=next;node.scrollTop=preserveAnchor&&anchor?Math.max(0,next.indexOf(anchor))*rowHeight+offset:0;setPosition(p=>({...p,top:node.scrollTop}));},[keys]);
 useEffect(()=>{const changed=lastSelected.current!==selectedKey;lastSelected.current=selectedKey;if(!virtual||!selectedKey||preserveAnchor&&!changed)return;const node=viewport.current,index=items.findIndex(item=>itemKey(item)===selectedKey);if(!node||index<0)return;const top=index*rowHeight;if(top<node.scrollTop||top+rowHeight>node.scrollTop+node.clientHeight)node.scrollTop=Math.max(0,top-node.clientHeight/2);setPosition({top:node.scrollTop,height:node.clientHeight||500});},[selectedKey,keys]);
 const start=virtual?Math.max(0,Math.min(items.length-1,Math.floor(position.top/rowHeight)-4)):0,end=virtual?Math.min(items.length,start+Math.ceil(position.height/rowHeight)+8):items.length;
 return <div ref={viewport} className={className+(virtual?' virtual-list':'')} role="list" onScroll={event=>setPosition({top:event.currentTarget.scrollTop,height:event.currentTarget.clientHeight||500})}>
  {!items.length&&empty}{virtual&&<div aria-hidden="true" style={{height:start*rowHeight}}/>}{items.slice(start,end).map((item,index)=><div key={itemKey(item)} role="listitem" aria-posinset={start+index+1} aria-setsize={items.length} style={virtual?{height:rowHeight}:undefined}>{render(item)}</div>)}{virtual&&<div aria-hidden="true" style={{height:(items.length-end)*rowHeight}}/>}
 </div>;
}
