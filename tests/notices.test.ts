import test from 'node:test';import assert from 'node:assert/strict';
import {NoticeStore,type NoticeOptions} from '../src/renderer/notice-store';
test('notices queue in order, merge duplicates while visible, and return the actual chosen button',async()=>{
 const store=new NoticeStore(),first=store.show({message:'保存完成'}),duplicate=store.show({message:'保存完成'});assert.equal(first,duplicate);
 const firstId=store.current()!.id,second=store.show({message:'放弃编辑？',buttons:['取消','放弃'],cancelButton:0});
 assert.equal(store.current()!.message,'保存完成');store.choose(firstId,0);assert.equal(await first,0);assert.equal(store.current()!.message,'放弃编辑？');
 store.choose(firstId,1);assert.equal(store.current()!.message,'放弃编辑？');store.choose(store.current()!.id,1);assert.equal(await second,1);assert.equal(store.current(),null);
 const again=store.show({message:'保存完成'});store.choose(store.current()!.id,0);assert.equal(await again,0);
});
test('one or two buttons only, valid default/cancel choices, no empty or malformed reminders',async()=>{
 for(const input of [{message:''},{message:'x',buttons:[]},{message:'x',buttons:['a','b','c']},{message:'x',buttons:'a'},{message:'x',buttons:['a'],cancelButton:1},{message:'x',buttons:['a','b'],defaultButton:3},{message:'x',tone:'invalid'}]){
  const store=new NoticeStore();await assert.rejects(store.show(input as NoticeOptions),/参数无效/);assert.equal(store.current(),null);
 }
 const store=new NoticeStore();const pending=store.show({title:'权限确认',message:'是否继续？',buttons:['返回','继续'],defaultButton:1,cancelButton:0});assert.equal(store.current()!.defaultButton,1);assert.equal(store.current()!.cancelButton,0);store.choose(store.current()!.id,0);assert.equal(await pending,0);
});
