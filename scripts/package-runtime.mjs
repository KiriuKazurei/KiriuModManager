import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createRequire,isBuiltin} from 'node:module';
import ts from 'typescript';

// Resolve from the packaged files, and reject dependencies accidentally found in the checkout.
export async function verifyPackageRuntime(appDirectory,entries=['dist/main/index.js','dist/preload/index.js']){
 const root=path.resolve(appDirectory),pending=entries.map(entry=>path.resolve(root,entry)),visited=new Set(),dependencies=new Set();
 const inside=file=>{const relative=path.relative(root,file);return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
 while(pending.length){
  const file=pending.pop();if(!inside(file))throw new Error('Runtime module escaped package: '+file);
  if(visited.has(file))continue;visited.add(file);
  if(!/\.(?:[cm]?js)$/.test(file)){await fs.access(file);continue;}
  const source=ts.createSourceFile(file,await fs.readFile(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),imports=[];
  function visit(node){if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='require'&&node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0]))imports.push(node.arguments[0].text);ts.forEachChild(node,visit);}
  visit(source);const require=createRequire(file);
  for(const specifier of imports){
   if(specifier==='electron'||isBuiltin(specifier))continue;
   let resolved;try{resolved=require.resolve(specifier);}catch(error){throw new Error(`Missing packaged runtime dependency ${specifier} required by ${path.relative(root,file)}`,{cause:error});}
   if(!inside(resolved))throw new Error(`Runtime dependency ${specifier} required by ${path.relative(root,file)} resolved outside package: ${resolved}`);
   if(!specifier.startsWith('.')&&!path.isAbsolute(specifier))dependencies.add(specifier);
   pending.push(resolved);
  }
 }
 return {filesChecked:visited.size,dependencies:[...dependencies].sort()};
}
