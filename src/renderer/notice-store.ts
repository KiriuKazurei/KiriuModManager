export type NoticeTone='info'|'success'|'warning'|'error';
export interface NoticeOptions {
 title?:string;message:string;detail?:string;tone?:NoticeTone;
 buttons?:readonly [string]|readonly [string,string];defaultButton?:0|1;cancelButton?:0|1;
}
export interface Notice {id:number;title:string;message:string;detail:string;tone:NoticeTone;buttons:readonly string[];defaultButton:number;cancelButton:number}
export class NoticeStore {
 private next=1;private entries:{notice:Notice;key:string;finish:(button:number)=>void;result:Promise<number>}[]=[];
 private listeners=new Set<()=>void>();
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 current=()=>this.entries[0]?.notice??null;
 private changed(){for(const listener of this.listeners)listener();}
 show(options:NoticeOptions):Promise<number>{
  if(!options||typeof options!=='object')return Promise.reject(new Error('提醒窗口参数无效。'));
  const buttons=options.buttons??['确定'],tone=options.tone??'info',title=options.title??({info:'提示',success:'操作完成',warning:'请确认',error:'操作未完成'}[tone]);
  const defaultButton=options.defaultButton??0,cancelButton=options.cancelButton??0;
  if(!['info','success','warning','error'].includes(tone)||typeof options.message!=='string'||!options.message.trim()||options.message.length>64000||typeof title!=='string'||!title.trim()||title.length>160||options.detail!==undefined&&(typeof options.detail!=='string'||options.detail.length>64000)||!Array.isArray(buttons)||buttons.length<1||buttons.length>2||buttons.some(label=>typeof label!=='string'||!label.trim()||label.length>64)||![0,1].includes(defaultButton)||![0,1].includes(cancelButton)||defaultButton>=buttons.length||cancelButton>=buttons.length)return Promise.reject(new Error('提醒窗口参数无效。'));
  const key=JSON.stringify([title,options.message,options.detail??'',tone,buttons,defaultButton,cancelButton]);const duplicate=this.entries.find(entry=>entry.key===key);if(duplicate)return duplicate.result;
  let finish!:(button:number)=>void;const result=new Promise<number>(resolve=>{finish=resolve;});
  this.entries.push({notice:{id:this.next++,title,message:options.message,detail:options.detail??'',tone,buttons:[...buttons],defaultButton,cancelButton},key,finish,result});this.changed();return result;
 }
 choose(id:number,button:number){const entry=this.entries[0];if(!entry||entry.notice.id!==id||!Number.isInteger(button)||button<0||button>=entry.notice.buttons.length)return;this.entries.shift();entry.finish(button);this.changed();}
}
export const notices=new NoticeStore();
export const showNotice=(options:NoticeOptions)=>notices.show(options);
export async function confirmNotice(message:string,options:Omit<NoticeOptions,'message'>={}){return await showNotice({title:'确认操作',tone:'warning',buttons:['取消','确认'],...options,message})===1;}
