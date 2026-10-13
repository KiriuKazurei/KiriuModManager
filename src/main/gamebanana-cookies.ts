import {promises as fs} from 'node:fs';
import type {Cookie,Cookies,SafeStorage} from 'electron';
import {assertNoLinks} from './archive';
import {writeAtomicJson} from './atomic-json';

type CookieStore=Pick<Cookies,'get'|'set'|'on'|'removeListener'|'flushStore'>;
type Encryption=Pick<SafeStorage,'isAsyncEncryptionAvailable'|'encryptStringAsync'|'decryptStringAsync'>;
const siteDomain=(domain:string)=>/^(?:[a-z0-9-]+\.)*gamebanana\.com$/i.test(domain.replace(/^\./,''));
const identity=(cookie:Cookie)=>JSON.stringify([cookie.domain,cookie.path,cookie.name]);

function sessionCookie(value:unknown):Cookie|null {
 if(!value||typeof value!=='object')return null;const c=value as Cookie;
 if(c.session!==true||c.expirationDate!==undefined||typeof c.domain!=='string'||!siteDomain(c.domain)||typeof c.path!=='string'||!c.path.startsWith('/')||typeof c.name!=='string'||typeof c.value!=='string'||c.name.length+c.value.length>8192||typeof c.hostOnly!=='boolean'||typeof c.secure!=='boolean'||typeof c.httpOnly!=='boolean'||!['unspecified','no_restriction','lax','strict'].includes(c.sameSite))return null;
 return {domain:c.domain,path:c.path,name:c.name,value:c.value,hostOnly:c.hostOnly,secure:c.secure,httpOnly:c.httpOnly,sameSite:c.sameSite,session:true};
}

// Chromium persists dated cookies itself. Only GameBanana's session cookies need
// encrypted restoration; never extend a dated cookie's lifetime or replay logout.
export class GameBananaCookies {
 error='';
 private encrypted=false;
 private pending:Promise<void>=Promise.resolve();
 constructor(private cookies:CookieStore,private file:string,private encryption:Encryption){}
 async initialize(){
  try{
   this.encrypted=await this.encryption.isAsyncEncryptionAvailable();
   if(!this.encrypted)throw new Error('encryption unavailable');
   await assertNoLinks(this.file);
   let text:string|undefined;
   try{if((await fs.stat(this.file)).size>1024*1024)throw new Error('invalid size');text=await fs.readFile(this.file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   if(text){
    const envelope=JSON.parse(text);
    if(envelope.version!==1||typeof envelope.encrypted!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.encrypted))throw new Error('invalid storage');
    const decrypted=await this.encryption.decryptStringAsync(Buffer.from(envelope.encrypted,'base64'));const saved=JSON.parse(decrypted.result);
    if(saved.version!==1||!Array.isArray(saved.cookies)||saved.cookies.length>512)throw new Error('invalid cookies');
    const existing=new Set((await this.cookies.get({})).map(identity));
    for(const value of saved.cookies){
     const cookie=sessionCookie(value);if(!cookie||existing.has(identity(cookie)))continue;
     await this.cookies.set({url:'https://'+cookie.domain!.replace(/^\./,'')+cookie.path,name:cookie.name,value:cookie.value,path:cookie.path,secure:cookie.secure,httpOnly:cookie.httpOnly,sameSite:cookie.sameSite,...(!cookie.hostOnly?{domain:cookie.domain}:{})});
    }
   }
  }catch{this.error='GameBanana 登录记录无法恢复，请在网页重新登录；本地加密存储不可用时无法记住会话登录。';}
  this.cookies.on('changed',this.changed);
  if(!this.error)await this.save();
 }
 private changed=(_event:unknown,cookie:Cookie)=>{if(cookie.domain&&siteDomain(cookie.domain))void this.save();};
 private save(){
  this.pending=this.pending.then(async()=>{
   await this.cookies.flushStore();
   if(!this.encrypted)return;
   const cookies=(await this.cookies.get({session:true})).map(sessionCookie).filter((cookie):cookie is Cookie=>!!cookie);
   const encrypted=await this.encryption.encryptStringAsync(JSON.stringify({version:1,cookies}));
   await writeAtomicJson(this.file,JSON.stringify({version:1,encrypted:encrypted.toString('base64')}));this.error='';
  }).catch(()=>{this.error='GameBanana 登录记录保存失败，请检查本地数据目录；下次启动可能需要重新登录。';});return this.pending;
 }
 async close(){this.cookies.removeListener('changed',this.changed);await this.save();}
}
