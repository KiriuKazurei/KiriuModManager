import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {SettingsStore,defaultSettings} from '../src/main/settings';
import {ModService} from '../src/main/mods';
import {BusinessService} from '../src/main/business';
import {IniService} from '../src/main/ini';

const limit=4*1024**2;
const formats=[
  {name:'UTF-8',bom:Buffer.alloc(0),utf16:false,be:false},
  {name:'UTF-8 BOM',bom:Buffer.from([0xef,0xbb,0xbf]),utf16:false,be:false},
  {name:'UTF-16 LE',bom:Buffer.from([0xff,0xfe]),utf16:true,be:false},
  {name:'UTF-16 BE',bom:Buffer.from([0xfe,0xff]),utf16:true,be:true},
];
function encode(text:string,format:typeof formats[number]){
  const body=Buffer.from(text,format.utf16?'utf16le':'utf8');
  return Buffer.concat([format.bom,format.be?body.swap16():body]);
}
test('INI encoded byte limit includes BOM and newline expansion for text/keys; rejection leaves file and backup count unchanged',async()=>{
  const base=path.resolve('.run-data/modules-review/phase3-ini-tests');await fs.mkdir(base,{recursive:true});
  const run=await fs.mkdtemp(path.join(base,'run-'));const data=path.join(run,'data');
  const settings=defaultSettings();
  for(const game of ['zzz','endfield']as const){const modsDirectory=path.join(run,game,'Mods');await fs.mkdir(path.join(modsDirectory,'Fixture'),{recursive:true});settings.games[game]={xxmiRoot:'',gameDirectory:'',modsDirectory};await fs.writeFile(path.join(modsDirectory,'Fixture','main.ini'),'[KeyLimit]\r\nkey=A\r\n');}
  const store=new SettingsStore(data);await store.save(settings);
  const mods=new ModService(data,async game=>(await store.read()).games[game]);const business=new BusinessService(data,mods,store);const ini=new IniService(mods,business.recovery);
  for(const game of ['zzz','endfield']as const){const mod=(await mods.scan(game)).mods[0];
    for(const format of formats){const relativePath=format.name.replaceAll(' ','-')+'.ini';const target=path.join(settings.games[game].modsDirectory,mod.relativePath,relativePath);
      const original=encode('[KeyLimit]\r\nkey=A\r\n;中文\r\n',format);await fs.writeFile(target,original);
      let document=await ini.read(game,mod.id,relativePath);const before=(await business.recovery.list(game)).length;
      const rejected=format.utf16?'中'.repeat(limit/2):'中'.repeat(Math.ceil(limit/3));
      assert.ok(encode(rejected,format).length>limit || format.name==='UTF-8');
      // All requested edits have <= limit JS characters, but encoded bytes exceed it.
      const tooLarge=format.name==='UTF-8'?rejected+'中':rejected;
      await assert.rejects(ini.save(game,mod.id,relativePath,document.digest,{kind:'text',text:tooLarge}),/编码后超过4MB/);
      assert.deepEqual(await fs.readFile(target),original);assert.equal((await business.recovery.list(game)).length,before);
      // Accept the inclusive byte boundary, including each BOM, then reject key growth.
      const header='[KeyLimit]\r\nkey=A\r\n;';const padding=(limit-encode(header,format).length)/(format.utf16?2:1);
      const boundary=header+'x'.repeat(padding);assert.equal(encode(boundary,format).length,limit);
      document=await ini.save(game,mod.id,relativePath,document.digest,{kind:'text',text:boundary});
      const exact=await fs.readFile(target);assert.equal(exact.length,limit);assert.equal(document.encoding,format.name);assert.equal(document.newline,'CRLF');assert.equal(document.digest,createHash('sha256').update(exact).digest('hex'));assert.deepEqual(exact.subarray(0,format.bom.length),format.bom);
      const count=(await business.recovery.list(game)).length;
      await assert.rejects(ini.save(game,mod.id,relativePath,document.digest,{kind:'keys',keys:document.keys.map(key=>({...key,key:'中'.repeat(500)}))}),/编码后超过4MB/);
      assert.deepEqual(await fs.readFile(target),exact);assert.equal((await business.recovery.list(game)).length,count);
      // Normalized LF input expands to the original CRLF; enforce the output bytes.
      const expanded=boundary.replaceAll('\r\n','\n')+'\n';await assert.rejects(ini.save(game,mod.id,relativePath,document.digest,{kind:'text',text:expanded}),/编码后超过4MB/);
      assert.deepEqual(await fs.readFile(target),exact);assert.equal((await business.recovery.list(game)).length,count);
    }
  }
});
