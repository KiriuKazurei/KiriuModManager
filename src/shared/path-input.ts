import type {GameId,GamePaths} from './contracts';

export const GAME_EXECUTABLE_NAMES = {
  zzz: ['ZenlessZoneZero.exe', 'ZenlessZoneZeroBeta.exe'],
  endfield: ['Endfield.exe'],
} as const;

// This only recognizes input syntax. The main process verifies files before saving.
export function normalizeGamePathInput(game:GameId,field:keyof GamePaths,input:string):string {
  const value=input.trim().replace(/^"(.*)"$/, '$1').trim();
  if(field==='xxmiRoot') {
    const match=/^(.*)([\\/])Resources(?:[\\/]Bin(?:[\\/]XXMI Launcher\.exe)?)?[\\/]*$/i.exec(value);
    if(match)return match[1] ? match[1]+(/^[a-z]:$/i.test(match[1])?match[2]:'') : match[2];
  }
  if(field==='gameDirectory') {
    const separator=Math.max(value.lastIndexOf('\\'),value.lastIndexOf('/'));
    if(separator>=0&&GAME_EXECUTABLE_NAMES[game].some(name=>name.toLowerCase()===value.slice(separator+1).toLowerCase())) {
      return value.slice(0,separator+(separator===0||separator===2&&/^[a-z]:/i.test(value)?1:0));
    }
  }
  return value;
}
