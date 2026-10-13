import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import type {Cookie,Cookies,CookiesSetDetails} from 'electron';
import {GameBananaCookies} from '../src/main/gamebanana-cookies';

const key=randomBytes(32);
const encryption={isAsyncEncryptionAvailable:async()=>true,encryptStringAsync:async(text:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),bytes]);},decryptStringAsync:async(bytes:Buffer)=>{const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return {result:Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'),shouldReEncrypt:false};}};
const cookie=(changes:Partial<Cookie>={}):Cookie=>({name:'login',value:'fixture-secret',domain:'gamebanana.com',path:'/',hostOnly:true,httpOnly:true,secure:true,sameSite:'lax',session:true,...changes});
class Jar extends EventEmitter {
 values:Cookie[]=[];flushed=0;
 async get(filter:{session?:boolean}){return this.values.filter(c=>filter.session===undefined||c.session===filter.session).map(c=>({...c}));}
 async flushStore(){this.flushed++;}
 async set(details:CookiesSetDetails){const {url,...attributes}=details;this.change(cookie({...attributes,domain:details.domain||new URL(url).hostname,hostOnly:!details.domain,session:details.expirationDate===undefined}));}
 change(c:Cookie,removed=false){this.values=this.values.filter(value=>!(value.name===c.name&&value.domain===c.domain&&value.path===c.path));if(!removed)this.values.push(c);this.emit('changed',{},c,'explicit',removed);}
 native(){return this as unknown as Cookies;}
}
async function fixture(){const parent=path.resolve('.run-data/cookie-tests');await fs.mkdir(parent,{recursive:true});return path.join(await fs.mkdtemp(path.join(parent,'run-')),'cookies.json');}

test('encrypted session cookies restore scope/attributes and never override dated native cookies',async()=>{
 const file=await fixture(),jar=new Jar();const store=new GameBananaCookies(jar.native(),file,encryption);await store.initialize();
 jar.change(cookie());jar.change(cookie({name:'domain-login',domain:'.gamebanana.com',path:'/mods',hostOnly:false,sameSite:'strict'}));jar.change(cookie({name:'dated',session:false,expirationDate:Date.now()/1000+3600}));jar.change(cookie({name:'unrelated',domain:'other.test'}));await store.close();
 const text=await fs.readFile(file,'utf8');assert.ok(!text.includes('fixture-secret'));assert.ok(!text.includes('domain-login'));
 const restarted=new Jar();restarted.values=[cookie({value:'new-native',session:false,expirationDate:Date.now()/1000+3600})];const restore=new GameBananaCookies(restarted.native(),file,encryption);await restore.initialize();assert.equal(restore.error,'');
 assert.equal(restarted.values.find(c=>c.name==='login')?.value,'new-native');assert.deepEqual(restarted.values.find(c=>c.name==='domain-login'),cookie({name:'domain-login',domain:'.gamebanana.com',path:'/mods',hostOnly:false,sameSite:'strict'}));assert.equal(restarted.values.length,2);await restore.close();assert.ok(jar.flushed>0);
});
test('login rotation and logout drain queued writes so restart does not resurrect removed cookies',async()=>{
 const file=await fixture(),jar=new Jar(),store=new GameBananaCookies(jar.native(),file,encryption);await store.initialize();jar.change(cookie());jar.change(cookie(),true);jar.change(cookie({value:'rotated'}));await store.close();
 const next=new Jar(),restore=new GameBananaCookies(next.native(),file,encryption);await restore.initialize();assert.equal(next.values[0].value,'rotated');next.change(next.values[0],true);await restore.close();
 const loggedOut=new Jar(),final=new GameBananaCookies(loggedOut.native(),file,encryption);await final.initialize();assert.deepEqual(loggedOut.values,[]);await final.close();
});
test('unavailable encryption writes no plaintext; corrupt or foreign stored cookies do not block browsing',async()=>{
 const file=await fixture(),jar=new Jar(),unavailable=new GameBananaCookies(jar.native(),file,{...encryption,isAsyncEncryptionAvailable:async()=>false});await unavailable.initialize();jar.change(cookie());await unavailable.close();assert.match(unavailable.error,/加密/);await assert.rejects(fs.stat(file),{code:'ENOENT'});
 await fs.writeFile(file,'corrupt fixture');const corrupt=new GameBananaCookies(jar.native(),file,encryption);await corrupt.initialize();assert.match(corrupt.error,/恢复/);await corrupt.close();
 const encrypted=await encryption.encryptStringAsync(JSON.stringify({version:1,cookies:[cookie({domain:'gamebanana.com.evil.test'}),cookie({expirationDate:1}),cookie({domain:'../outside'})]}));await fs.writeFile(file,JSON.stringify({version:1,encrypted:encrypted.toString('base64')}));const safe=new Jar(),restore=new GameBananaCookies(safe.native(),file,encryption);await restore.initialize();assert.deepEqual(safe.values,[]);await restore.close();
});
