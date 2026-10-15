import assert from 'node:assert/strict';
// Current F01 flow for older window regressions. Only this operation's native
// confirmation is driven; the caller's other dialog behavior is restored.
export async function confirmImportPreview(page,app,expected){
 const panel=page.getByRole('region',{name:'导入预检',exact:true});
 await panel.getByRole('button',{name:'确认导入所选 Mod',exact:true}).waitFor();
 await app.evaluate(({dialog})=>{globalThis.__smokeImportOriginal=dialog.showMessageBox;dialog.showMessageBox=async(...args)=>args.at(-1)?.title==='确认导入 Mod'?{response:1,checkboxChecked:false}:globalThis.__smokeImportOriginal(...args);});
 try{await panel.getByRole('button',{name:'确认导入所选 Mod',exact:true}).click();const receipt=panel.locator('.import-receipt > strong');await receipt.waitFor();if(expected!==undefined)assert.equal(await receipt.innerText(),`已导入 ${expected} 项，默认停用。`);return await panel.locator('.import-receipt').innerText();}
 finally{await app.evaluate(({dialog})=>{dialog.showMessageBox=globalThis.__smokeImportOriginal;delete globalThis.__smokeImportOriginal;});if(await panel.locator('.import-receipt').count())await panel.getByRole('button',{name:'关闭导入预检',exact:true}).click();}
}
