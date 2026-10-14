import {promises as fs} from 'node:fs';

// Check the current file identity on every read; retain only a bounded amount of
// decoded transport data. External edits/deletion must never reuse an old cover.
export class ImageCache {
 private entries=new Map<string,{stamp:string;bytes:Buffer}>();
 private size=0;
 async read(file:string):Promise<Buffer>{
  const stat=await fs.stat(file);if(!stat.isFile()||stat.size>10*1024**2)throw new Error('封面文件无效或超过 10 MB。');
  const stamp=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');const cached=this.entries.get(file);
  if(cached?.stamp===stamp){this.entries.delete(file);this.entries.set(file,cached);return cached.bytes;}
  if(cached){this.entries.delete(file);this.size-=cached.bytes.length;}
  const bytes=await fs.readFile(file);this.entries.set(file,{stamp,bytes});this.size+=bytes.length;
  while(this.size>32*1024**2||this.entries.size>128){const oldest=this.entries.keys().next().value!;this.size-=this.entries.get(oldest)!.bytes.length;this.entries.delete(oldest);}
  return bytes;
 }
}
