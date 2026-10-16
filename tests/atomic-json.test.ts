import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeAtomicFile} from '../src/main/atomic-json';
async function fixture(){const parent=path.resolve('.run-data/atomic-json-tests');await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'run-')),logical=path.join(root,'logical'),actual=path.join(root,'actual');await fs.mkdir(logical);await fs.mkdir(actual);return {logical,actual};}
test('atomic writes resolve a redirected parent before creating and renaming the temporary file',async()=>{
 const {logical,actual}=await fixture(),realpath=fs.realpath,rename=fs.rename,transitions:string[][]=[];
 fs.realpath=(async(file,...args:any[])=>String(file)===logical?actual:(realpath as any)(file,...args)) as typeof fs.realpath;
 fs.rename=async(source,target)=>{transitions.push([String(source),String(target)]);if(path.dirname(String(source))===logical||path.dirname(String(target))===logical)throw Object.assign(new Error('virtualized rename'),{code:'EXDEV'});return rename(source,target);};
 try{await writeAtomicFile(path.join(logical,'settings.json'),'first','missing');await writeAtomicFile(path.join(logical,'settings.json'),'second',createHash('sha256').update('first').digest('hex'));}
 finally{fs.realpath=realpath;fs.rename=rename;}
 assert.equal(await fs.readFile(path.join(actual,'settings.json'),'utf8'),'second');assert.equal(transitions.length,2);assert.ok(transitions.every(([source,target])=>path.dirname(source)===actual&&path.dirname(target)===actual));
});
test('redirected atomic writes preserve concurrent content when the expected digest is stale',async()=>{
 const {logical,actual}=await fixture(),realpath=fs.realpath;await fs.writeFile(path.join(actual,'settings.json'),'external');
 fs.realpath=(async(file,...args:any[])=>String(file)===logical?actual:(realpath as any)(file,...args)) as typeof fs.realpath;
 try{await assert.rejects(writeAtomicFile(path.join(logical,'settings.json'),'replacement',createHash('sha256').update('old').digest('hex')),/修改/);}
 finally{fs.realpath=realpath;}
 assert.equal(await fs.readFile(path.join(actual,'settings.json'),'utf8'),'external');
});
test('an inconsistent existing file mapping is retained instead of writing a different destination',async()=>{
 const {logical,actual}=await fixture(),file=path.join(logical,'settings.json'),realpath=fs.realpath;await fs.writeFile(file,'retain');
 fs.realpath=(async(location,...args:any[])=>String(location)===logical?actual:(realpath as any)(location,...args)) as typeof fs.realpath;
 try{await assert.rejects(writeAtomicFile(file,'replacement'),/实际路径不一致/);}finally{fs.realpath=realpath;}
 assert.equal(await fs.readFile(file,'utf8'),'retain');await assert.rejects(fs.access(path.join(actual,'settings.json')));
});
