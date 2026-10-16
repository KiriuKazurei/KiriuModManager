import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {verifyPackageRuntime} from '../scripts/package-runtime.mjs';
async function fixture(source:string){const parent=path.resolve('.run-data/package-runtime-tests');await fs.mkdir(parent,{recursive:true});const app=await fs.mkdtemp(path.join(parent,'run-'));await fs.mkdir(path.join(app,'dist/main'),{recursive:true});await fs.writeFile(path.join(app,'package.json'),'{}');await fs.writeFile(path.join(app,'dist/main/index.js'),source);return app;}
test('package validation rejects omitted fflate even when checkout node_modules can satisfy resolution',async()=>{
 const app=await fixture('require("fflate");');
 await assert.rejects(verifyPackageRuntime(app,['dist/main/index.js']),/fflate.*outside package/);
});
test('package validation follows transitive runtime dependencies instead of accepting only top-level resolution',async()=>{
 const app=await fixture('require("fixture-package");'),pkg=path.join(app,'node_modules/fixture-package');await fs.mkdir(pkg,{recursive:true});await fs.writeFile(path.join(pkg,'package.json'),'{"main":"index.js"}');await fs.writeFile(path.join(pkg,'index.js'),'require("pend");');
 await assert.rejects(verifyPackageRuntime(app,['dist/main/index.js']),/pend.*outside package/);
});
test('complete packaged fflate passes closure verification and performs a real ZIP round trip',async()=>{
 const app=await fixture('require("node:fs"); require("electron"); module.exports=require("fflate");');await fs.cp(path.resolve('node_modules/fflate'),path.join(app,'node_modules/fflate'),{recursive:true});
 const report=await verifyPackageRuntime(app,['dist/main/index.js']);assert.ok(report.dependencies.includes('fflate'));assert.ok(report.filesChecked>1);
 const require=createRequire(path.join(app,'package.json')),codec=require('fflate'),bytes=Buffer.from('packaged preset content');assert.deepEqual(Buffer.from(codec.unzipSync(codec.zipSync({'preset.json':bytes}))['preset.json']),bytes);
});
test('package validation rejects a missing relative compiled module',async()=>{
 const app=await fixture('require("./missing.js");');await assert.rejects(verifyPackageRuntime(app,['dist/main/index.js']),/Missing packaged runtime dependency .\/missing.js/);
});
