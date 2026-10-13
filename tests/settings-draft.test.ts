import test from 'node:test';import assert from 'node:assert/strict';import path from 'node:path';
import {defaultSettings} from '../src/main/settings';
import {acceptSubmittedGamePaths,acceptSubmittedPreferences,dirtyPatch,gameDraftDirty,rebaseSettingsDraft,settingsForGame,mergeDesktopDraft} from '../src/renderer/settings-draft';
test('incoming settings refresh untouched fields and saving one game keeps the other game draft without persisting it',()=>{
 const baseline=defaultSettings();const draft=structuredClone(baseline);draft.games.zzz.gameDirectory=path.resolve('.run-data/modules-review/phase1-tests/zzz-draft');draft.games.endfield.modsDirectory=path.resolve('.run-data/modules-review/phase1-tests/end-draft');
 const latest=structuredClone(baseline);latest.games.zzz.modsDirectory=path.resolve('.run-data/modules-review/phase1-tests/zzz-external');latest.games.endfield.xxmiRoot=path.resolve('.run-data/modules-review/phase1-tests/end-external');latest.desktop={marketUrl:'https://example.com/latest',updateUrl:'',closeToTray:false};
 const state=rebaseSettingsDraft({draft,baseline},latest);assert.equal(state.draft.games.zzz.gameDirectory,draft.games.zzz.gameDirectory);assert.equal(state.draft.games.zzz.modsDirectory,latest.games.zzz.modsDirectory);assert.equal(state.draft.games.endfield.modsDirectory,draft.games.endfield.modsDirectory);assert.equal(state.draft.games.endfield.xxmiRoot,latest.games.endfield.xxmiRoot);
 const requested=settingsForGame(state,latest,'zzz');assert.deepEqual(requested.games.endfield,latest.games.endfield);assert.deepEqual(requested.desktop,latest.desktop);assert.equal(requested.games.zzz.gameDirectory,draft.games.zzz.gameDirectory);assert.equal(requested.games.zzz.modsDirectory,latest.games.zzz.modsDirectory);
 const committed=rebaseSettingsDraft(state,requested,'zzz');assert.equal(gameDraftDirty(committed,'zzz'),false);assert.equal(gameDraftDirty(committed,'endfield'),true);assert.equal(committed.draft.games.endfield.modsDirectory,draft.games.endfield.modsDirectory);
 const endRequest=settingsForGame(committed,requested,'endfield');assert.equal(endRequest.games.endfield.modsDirectory,draft.games.endfield.modsDirectory);assert.deepEqual(endRequest.games.zzz,requested.games.zzz);
});
test('desktop draft retains the edited URL while external URL and close preference refresh',()=>{
 const baseline={marketUrl:'',updateUrl:'',closeToTray:true};const draft={...baseline,marketUrl:'https://example.com/local'};const latest={marketUrl:'https://example.com/external',updateUrl:'https://example.com/new-releases',closeToTray:false};
 assert.deepEqual(mergeDesktopDraft(draft,baseline,latest),{...latest,marketUrl:draft.marketUrl});
});
test('submitted path fields accept the saved value while a field edited again and the other game stay dirty',()=>{
 const baseline=defaultSettings();const draft=structuredClone(baseline);draft.games.zzz.xxmiRoot='  D:\\ZZMI  ';draft.games.zzz.gameDirectory='D:\\Game';draft.games.endfield.modsDirectory='D:\\EndMods';
 const submitted=dirtyPatch(draft.games.zzz,baseline.games.zzz);assert.deepEqual(submitted,{xxmiRoot:'  D:\\ZZMI  ',gameDirectory:'D:\\Game'});
 draft.games.zzz.gameDirectory='D:\\Game-Edited';
 const saved=structuredClone(baseline);saved.games.zzz.xxmiRoot='D:\\ZZMI';saved.games.zzz.gameDirectory='D:\\Game';saved.games.zzz.modsDirectory='D:\\ExternalMods';saved.games.endfield.xxmiRoot='D:\\ExternalEnd';
 const next=acceptSubmittedGamePaths({draft,baseline},saved,'zzz',submitted);
 assert.equal(next.draft.games.zzz.xxmiRoot,'D:\\ZZMI');assert.equal(next.baseline.games.zzz.xxmiRoot,'D:\\ZZMI');
 assert.equal(next.draft.games.zzz.gameDirectory,'D:\\Game-Edited');assert.equal(next.baseline.games.zzz.gameDirectory,'D:\\Game');assert.equal(gameDraftDirty(next,'zzz'),true);
 assert.equal(next.draft.games.zzz.modsDirectory,'D:\\ExternalMods');assert.equal(next.draft.games.endfield.modsDirectory,'D:\\EndMods');assert.equal(next.draft.games.endfield.xxmiRoot,'D:\\ExternalEnd');assert.equal(gameDraftDirty(next,'endfield'),true);
});
test('submitted desktop fields accept the saved value and a preference edited again stays dirty',()=>{
 const baseline={marketUrl:'',updateUrl:'',closeToTray:true};const draft={...baseline,marketUrl:' https://example.com/mods ',updateUrl:'https://example.com/local'};
 const submitted=dirtyPatch(draft,baseline);const edited={...draft,updateUrl:'https://example.com/changed'};
 const saved={marketUrl:'https://example.com/mods',updateUrl:'https://example.com/external',closeToTray:false};
 const next=acceptSubmittedPreferences(edited,baseline,saved,submitted);
 assert.equal(next.draft.marketUrl,'https://example.com/mods');assert.equal(next.draft.updateUrl,'https://example.com/changed');assert.equal(next.draft.closeToTray,false);assert.deepEqual(next.baseline,saved);
});
