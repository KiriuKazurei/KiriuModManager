import test from 'node:test';import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import ts from 'typescript';
test('transient operation feedback and renderer confirmations use the common notice interface',async()=>{
 const failures:string[]=[];
 for(const file of await fs.readdir('src/renderer')){
  if(!file.endsWith('.tsx')||file==='Notices.tsx')continue;
  const source=await fs.readFile('src/renderer/'+file,'utf8'),ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  // Per-file error rows in a retained inspection report are data, not transient operation banners.
  function reportRow(node:ts.Node){for(let parent=node.parent;parent;parent=parent.parent)if(ts.isArrowFunction(parent)&&parent.parameters.some(parameter=>parameter.name.getText(ast)==='error')&&ts.isCallExpression(parent.parent)&&ts.isPropertyAccessExpression(parent.parent.expression)&&parent.parent.expression.name.text==='map')return true;return false;}
  function visit(node:ts.Node){
   if(ts.isCallExpression(node)&&node.expression.getText(ast)==='window.confirm')failures.push(file+': browser-native confirmation');
   if(ts.isJsxElement(node)&&node.openingElement.tagName.getText(ast)==='p'&&!reportRow(node))for(const child of node.children)if(ts.isJsxExpression(child)&&child.expression&&['error','message','notice','desktopMessage','error||status?.error'].includes(child.expression.getText(ast)))failures.push(file+': inline operation feedback');
   ts.forEachChild(node,visit);
  }visit(ast);
 }
 assert.deepEqual(failures,[]);
});
