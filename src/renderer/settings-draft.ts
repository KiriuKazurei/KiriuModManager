import type {DesktopPreferences,GameId,GamePaths,Settings} from '../shared/contracts';

const games:GameId[]=['zzz','endfield'];
const pathFields:(keyof GamePaths)[]=['xxmiRoot','gameDirectory','modsDirectory'];
export interface SettingsDraft {draft:Settings;baseline:Settings}

// Incoming saved values replace untouched fields; explicit local edits remain drafts.
export function rebaseSettingsDraft(state:SettingsDraft,latest:Settings,committedGame?:GameId):SettingsDraft {
  const next:Settings={...latest,games:{...latest.games}};
  for(const game of games) {
    next.games[game]={...latest.games[game]};
    if(game!==committedGame)for(const field of pathFields)if(state.draft.games[game][field]!==state.baseline.games[game][field])next.games[game][field]=state.draft.games[game][field];
  }
  return {draft:next,baseline:latest};
}
export function settingsForGame(state:SettingsDraft,latest:Settings,game:GameId):Settings {
  const fields={...latest.games[game]};
  for(const field of pathFields)if(state.draft.games[game][field]!==state.baseline.games[game][field])fields[field]=state.draft.games[game][field];
  return {...latest,selectedGame:game,games:{...latest.games,[game]:fields}};
}
export function gameDraftDirty(state:SettingsDraft,game:GameId):boolean {return pathFields.some(field=>state.draft.games[game][field]!==state.baseline.games[game][field]);}
const preferenceFields:(keyof DesktopPreferences)[]=['marketUrl','updateUrl','closeToTray','updateSourceUrl'];
function assignPreference<K extends keyof DesktopPreferences>(target:DesktopPreferences,field:K,value:DesktopPreferences[K]){target[field]=value;}
export function desktopPreferences(settings:Settings):DesktopPreferences {return settings.desktop||{marketUrl:'',updateUrl:'',closeToTray:true};}
export function mergeDesktopDraft(draft:DesktopPreferences,baseline:DesktopPreferences,latest:DesktopPreferences):DesktopPreferences {
  return {
    ...latest,
    ...(draft.updateSourceUrl!==baseline.updateSourceUrl?{updateSourceUrl:draft.updateSourceUrl}:{}),
    marketUrl:draft.marketUrl!==baseline.marketUrl?draft.marketUrl:latest.marketUrl,
    updateUrl:draft.updateUrl!==baseline.updateUrl?draft.updateUrl:latest.updateUrl,
    closeToTray:draft.closeToTray!==baseline.closeToTray?draft.closeToTray:latest.closeToTray,
  };
}
export function dirtyPatch<T extends object>(draft:T,baseline:T):Partial<T> {
  return Object.fromEntries((Object.keys(draft) as (keyof T)[]).filter(key=>draft[key]!==baseline[key]).map(key=>[key,draft[key]])) as Partial<T>;
}
// Accept only submitted fields the user has not edited again; keep other dirty drafts and move their baseline to the saved value.
export function acceptSubmittedGamePaths(state:SettingsDraft,saved:Settings,game:GameId,submitted:Partial<GamePaths>):SettingsDraft {
  const next=rebaseSettingsDraft(state,saved);
  for(const field of pathFields)if(Object.hasOwn(submitted,field)&&state.draft.games[game][field]===submitted[field])next.draft.games[game][field]=saved.games[game][field];
  return next;
}
export function acceptSubmittedPreferences(draft:DesktopPreferences,baseline:DesktopPreferences,saved:DesktopPreferences,submitted:Partial<DesktopPreferences>):{draft:DesktopPreferences;baseline:DesktopPreferences} {
  const next=mergeDesktopDraft(draft,baseline,saved);
  for(const field of preferenceFields)if(Object.hasOwn(submitted,field)&&draft[field]===submitted[field])assignPreference(next,field,saved[field]);
  return {draft:next,baseline:saved};
}
