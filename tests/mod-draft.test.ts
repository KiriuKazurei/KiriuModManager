import test from 'node:test';import assert from 'node:assert/strict';import {rebaseModDraft} from '../src/renderer/mod-draft';
const original={id:'one',name:'Original',metadata:{category:'角色',character:'安比',appearance:'日常',author:'',description:''}};
test('same-Mod refresh keeps unsaved name and metadata while untouched fields refresh; a different Mod/game clears identity',()=>{
 const state=rebaseModDraft(undefined,'zzz',original);state.name='UnsavedName';state.metadata.author='UnsavedAuthor';state.metadata.description='UnsavedDescription';const incoming={...original,metadata:{...original.metadata,appearance:'外部更新'}};
 const refreshed=rebaseModDraft(state,'zzz',incoming);assert.equal(refreshed.name,state.name);assert.equal(refreshed.metadata.author,state.metadata.author);assert.equal(refreshed.metadata.description,state.metadata.description);assert.equal(refreshed.metadata.appearance,incoming.metadata.appearance);
 assert.equal(rebaseModDraft(refreshed,'zzz',{...original,id:'two'}).name,original.name);assert.equal(rebaseModDraft(refreshed,'endfield',original).metadata.author,'');assert.equal(rebaseModDraft(refreshed,'zzz').modId,null);
});
test('own rename/metadata/classification accept saved fields without clearing unrelated unsaved fields',()=>{
 const state=rebaseModDraft(undefined,'zzz',original);state.name='local name';state.metadata={...state.metadata,category:'收藏',character:'自定义',appearance:'外观',author:'未保存作者',description:'未保存说明'};
 const renamed=rebaseModDraft(state,'zzz',{...original,name:'normalized name'},'rename');assert.equal(renamed.name,'normalized name');assert.equal(renamed.metadata.author,state.metadata.author);
 const moved=rebaseModDraft(renamed,'zzz',{...original,name:'normalized name',metadata:{...original.metadata,category:'收藏',character:'自定义',appearance:'外观'}},'classify');assert.equal(moved.name,'normalized name');assert.equal(moved.metadata.author,state.metadata.author);assert.equal(moved.metadata.description,state.metadata.description);assert.equal(moved.baseline.metadata.character,'自定义');
 moved.name='next unsaved rename';const saved=rebaseModDraft(moved,'zzz',{...original,name:'normalized name',metadata:{...moved.metadata,author:'保存的作者'}},'metadata');assert.equal(saved.name,'next unsaved rename');assert.equal(saved.metadata.author,'保存的作者');assert.equal(saved.metadata.author,saved.baseline.metadata.author);
});
