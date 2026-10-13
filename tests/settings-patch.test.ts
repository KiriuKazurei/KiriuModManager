import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {defaultSettings,mergeGamePaths,mergeDesktopPreferences} from '../src/main/settings';
test('game/desktop partial patches merge only owned fields, normalize allowed input and preserve selection and source',()=>{
  const original={...defaultSettings(),selectedGame:'endfield' as const,desktop:{closeToTray:false,marketUrl:'https://example.com/mods',updateUrl:'https://example.com/update'}};
  const before=structuredClone(original);const target=path.resolve('.run-data/modules-review/patch-nonexistent');
  const game=mergeGamePaths(original,'zzz',{modsDirectory:' '+target+' '});assert.equal(game.games.zzz.modsDirectory,target);assert.deepEqual(game.games.endfield,original.games.endfield);assert.equal(game.selectedGame,'endfield');assert.deepEqual(game.desktop,original.desktop);assert.deepEqual(original,before);
  const desktop=mergeDesktopPreferences(game,{closeToTray:true});assert.equal(desktop.desktop!.closeToTray,true);assert.equal(desktop.desktop!.marketUrl,original.desktop.marketUrl);assert.deepEqual(desktop.games,game.games);assert.equal(desktop.selectedGame,'endfield');
  assert.deepEqual(mergeDesktopPreferences(defaultSettings(),{marketUrl:''}).desktop,{closeToTray:true,marketUrl:'',updateUrl:''});
  assert.equal(mergeGamePaths(game,'zzz',{modsDirectory:''}).games.zzz.modsDirectory,'');
});
test('patch helpers reject empty, unknown, malformed path/URL/type fields without mutating saved input',()=>{
  const original=defaultSettings();const before=structuredClone(original);
  for(const patch of [null,[],{},'text',new Date(),{other:''},{selectedGame:'endfield'},{modsDirectory:4},{modsDirectory:undefined},{modsDirectory:'relative'},{modsDirectory:'bad\0path'},{xxmiRoot:'x'.repeat(32768)}])assert.throws(()=>mergeGamePaths(original,'zzz',patch));
  for(const patch of [null,[],{},'text',{games:{}},{closeToTray:'true'},{marketUrl:null},{marketUrl:'file:///unsafe'},{marketUrl:'https://user:pass@example.com'},{updateUrl:4},{updateUrl:undefined}])assert.throws(()=>mergeDesktopPreferences(original,patch));
  assert.throws(()=>mergeGamePaths(original,'other' as 'zzz',{modsDirectory:''}));assert.deepEqual(original,before);
});
