import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { GameId, GAMES, GamePaths, LibrarySnapshot, ModEntry, ModMetadata, ModOperation, ImportResult } from '../shared/contracts';
import { INITIAL_CHARACTERS, CHARACTER_ALIASES } from '../shared/characters';
import { assertNoLinks, containedPath } from './archive';
import { extractModArchive } from './mod-archive';
import { inspectXXMI } from './xxmi';
import { RecoveryStore } from './recovery';
interface RecordEntry { id: string; relativePath: string; metadata: ModMetadata; cover?: string; deleted?: string }
interface LibraryData { version: 1; root: string; records: Record<string, RecordEntry>; groups: { category: string[]; character: string[]; appearance: string[] }; characterCovers?:Record<string,string> }
const disabled = (name: string) => /^DISABLED/i.test(name);
const clean = (name: string) => name.replace(/^DISABLED_?/i, '');
const metadata = (): ModMetadata => ({ category:'', character:'', appearance:'', author:'', description:'' });
const initialCategories=['角色','功能','UI','场景','武器'];
export function safeName(value: unknown, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error('名称格式无效。');
  const name = value.trim();
  if (!name && allowEmpty) return '';
  if (!name || name.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(\.|\.\.|CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) throw new Error('名称不能为空，也不能包含路径符号或 Windows 保留名称。');
  return name;
}
function relation(parent: string, child: string) { const relative = path.relative(parent, child); return !relative || !relative.startsWith('..') && !path.isAbsolute(relative); }
async function present(file: string) { try { await fs.lstat(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function copyDirectory(source: string, destination: string) {
  await assertNoLinks(source); await assertNoLinks(destination);
  if (relation(source, destination) || relation(destination, source)) throw new Error('来源与目标相同或互相包含，不能复制。');
  if (await present(destination)) throw new Error('目标已存在同名目录，请改名后重试。');
  await fs.mkdir(destination, { recursive: true });
  const walk = async (from: string, to: string) => {
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      const input = path.join(from, entry.name); const output = containedPath(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error('来源包含链接目录，不能导入。');
      if (entry.isDirectory()) { await fs.mkdir(output); await walk(input, output); }
      else if (entry.isFile()) await fs.copyFile(input, output, constants.COPYFILE_EXCL);
      else throw new Error('来源包含特殊文件。');
    }
  };
  await walk(source, destination);
}
const resourceNames = new Set(['buffers','textures','meshes','shaders','shaderfixes','resources','__macosx','.git']);
const modIni = (name: string) => /\.ini$/i.test(name) && !/^desktop\.ini$/i.test(name);
async function hasIni(root: string, depth = 0): Promise<boolean> {
  if (depth > 16) return false;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isFile() && modIni(entry.name)) return true;
    if (entry.isDirectory() && !entry.isSymbolicLink() && !['.git','__macosx'].includes(entry.name.toLowerCase()) && await hasIni(path.join(root, entry.name), depth + 1)) return true;
  }
  return false;
}
async function discover(root: string, known = new Set<string>()): Promise<string[]> {
  const results: string[] = []; let examined = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 16 || ++examined > 20000) throw new Error('目录层级或数量过大，请缩小 Mod 根目录范围。');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const relative = path.relative(root, directory);
    const directIni = entries.some(entry => entry.isFile() && modIni(entry.name));
    const marker = entries.some(entry => entry.isFile() && ['mod.json','modinfo.json','.kmm-mod.json'].includes(entry.name.toLowerCase()));
    const resources = entries.some(entry => entry.isDirectory() && resourceNames.has(entry.name.toLowerCase())) || entries.some(entry => entry.isFile() && /\.(buf|vb|ib|dds)$/i.test(entry.name));
    if (relative && (directIni || known.has(relative) || (marker || resources) && await hasIni(directory))) { results.push(relative); return; }
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && !resourceNames.has(clean(entry.name).toLowerCase())) await walk(path.join(directory, entry.name), depth + 1);
  };
  await walk(root, 0); return results;
}
function inferred(game: GameId, relative: string, categories:readonly string[]): ModMetadata {
  const parts = relative.split(path.sep).map(clean); parts.pop();
  const result = metadata();
  // Registered categories disambiguate short layouts; unknown short paths keep
  // the established character/appearance interpretation. Existing records are untouched.
  if (parts.length >= 3 || parts.length>0&&categories.some(category=>category.toLowerCase()===parts[0].toLowerCase())) { result.category = parts.shift()!; result.character = parts.shift()||''; result.appearance = parts.join(' · '); }
  else { result.character = parts[0] || ''; result.appearance = parts.slice(1).join(' · '); result.category = result.character ? '角色' : ''; }
  const key = result.character.toLowerCase().replace(/[\s_-]+/g, '');
  result.character = CHARACTER_ALIASES[game][key] || result.character;
  return result;
}
function validateMetadata(value: ModMetadata): ModMetadata {
  return { category:safeName(value?.category, true), character:safeName(value?.character, true), appearance:safeName(value?.appearance, true), author: typeof value?.author === 'string' ? value.author.slice(0, 200) : '', description: typeof value?.description === 'string' ? value.description.slice(0, 5000) : '' };
}
export class ModService {
  constructor(private dataDirectory: string, private paths: (game: GameId) => Promise<GamePaths>) {}
  async characterCoverReferences(game:GameId){return (await this.load(game)).characterCovers||{};}
  async setCharacterCoverReference(game:GameId,name:string,file:string){const data=await this.load(game);data.characterCovers={...data.characterCovers,[name]:file};await this.save(game,data);}
  async context(game:GameId,id?:string){const data=await this.load(game);return {data,...(id?await this.resolve(data,id):{record:undefined,directory:data.root})};}
  async recoverRecord(game:GameId,input:unknown){const data=await this.load(game);const record=input as RecordEntry;if(!record||typeof record.id!=='string'||!record.relativePath)throw new Error('恢复元数据格式无效。');containedPath(data.root,record.relativePath);record.metadata=validateMetadata(record.metadata);delete record.deleted;data.records[record.id]=record;await this.save(game,data);return this.scan(game);}
  private file(game: GameId) { if (!Object.hasOwn(GAMES, game)) throw new Error('不支持的游戏。'); return path.join(this.dataDirectory, `library-${game}.json`); }
  private async load(game: GameId): Promise<LibraryData> {
    this.file(game);
    const config = await this.paths(game); const root = config.modsDirectory;
    if (!root || !path.isAbsolute(root)) throw new Error('请先在路径与加载器中保存该游戏的 Mod 目录。');
    if(path.resolve(root).toLowerCase()===path.parse(path.resolve(root)).root.toLowerCase())throw new Error('Mod 目录不能直接使用磁盘根目录，请选择专用文件夹。');
    await assertNoLinks(root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('已保存的 Mod 目录不存在，请检查路径。');
    let data: LibraryData | undefined;
    try { data = JSON.parse(await fs.readFile(this.file(game), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Mod 元数据配置无法读取，原文件已保留。'); }
    if (data && (data.version !== 1 || !data.records || !data.groups || typeof data.root !== 'string')) throw new Error('Mod 元数据配置格式无效，原文件已保留。');
    if (!data || data.root.toLowerCase() !== root.toLowerCase()) data = { version:1, root, records:{}, groups:{ category:[...initialCategories], character:[], appearance:[] } };
    return data;
  }
  private async save(game: GameId, data: LibraryData) { await fs.mkdir(this.dataDirectory, { recursive:true }); await fs.writeFile(this.file(game), JSON.stringify(data, null, 2), 'utf8'); }
  private async resolve(data: LibraryData, id: string): Promise<{record: RecordEntry; directory: string}> {
    if (typeof id !== 'string' || !Object.hasOwn(data.records, id) || data.records[id].deleted) throw new Error('Mod 不存在，请重新扫描。');
    const record = data.records[id]; const directory = containedPath(data.root, record.relativePath); await assertNoLinks(directory);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('Mod 目录已变化，请重新扫描。');
    return { record, directory };
  }
  private async makeEntry(data: LibraryData, record: RecordEntry): Promise<ModEntry> {
    const directory = containedPath(data.root, record.relativePath); const parts = record.relativePath.split(path.sep);
    const files = await fs.readdir(directory); const covers = files.find(file => /^((\.kmm-cover|cover|preview|thumbnail|_cover)\.(png|jpe?g|webp|gif))$/i.test(file));
    const ownDisabled = disabled(parts.at(-1)!); const disabledAncestors = parts.slice(0, -1).filter(disabled);
    const rootDisabled = disabled(path.basename(data.root)); if (rootDisabled) disabledAncestors.unshift(path.basename(data.root));
    let iniCount = 0;
    const count = async (folder: string) => { for (const entry of await fs.readdir(folder, { withFileTypes:true })) { if (entry.isFile() && modIni(entry.name)) iniCount++; if (entry.isDirectory() && !entry.isSymbolicLink()) await count(path.join(folder, entry.name)); } }; await count(directory);
    if (!record.cover && covers) record.cover = covers;
    return { id:record.id, name:clean(parts.at(-1)!), relativePath:record.relativePath, metadata:record.metadata, enabled:!ownDisabled && !disabledAncestors.length, ownDisabled, disabledAncestors, hasCover:!!record.cover && await present(containedPath(directory, record.cover)), iniCount };
  }
  async scan(game: GameId): Promise<LibrarySnapshot> {
    const data = await this.load(game); const relativePaths = await discover(data.root, new Set(Object.values(data.records).filter(record=>!record.deleted).map(record=>record.relativePath)));
    const mods: ModEntry[] = [];
    for (const relativePath of relativePaths) {
      let record = Object.values(data.records).find(record=>!record.deleted && record.relativePath === relativePath);
      if (!record) { const id=randomUUID(); record={id, relativePath, metadata:inferred(game, relativePath,data.groups.category)}; data.records[id]=record; }
      mods.push(await this.makeEntry(data, record));
    }
    await this.save(game, data);
    const warnings: string[]=[]; let loaderMatched=false; let excludeMatched=false;
    const config=await this.paths(game);
    try {
      const inspection=await inspectXXMI(game, config.xxmiRoot); loaderMatched=inspection.modsDirectories.some(directory=>relation(directory.toLowerCase(), data.root.toLowerCase()));
      if (inspection.importerExists) { const ini=await fs.readFile(inspection.iniPath,'utf8'); excludeMatched=/^\s*exclude_recursive\s*=\s*DISABLED\*\s*(?:;.*)?$/im.test(ini); }
    } catch { /* reports the missing loader below */ }
    if (!loaderMatched) warnings.push('当前 Mod 目录不在所选 loader 已确认的读取范围。管理操作仍可保存，但不代表游戏会加载；请到路径与加载器同步目录。');
    if (!excludeMatched) warnings.push('未确认 loader 的 exclude_recursive = DISABLED* 规则。目录停用不代表游戏已停用，请检查 XXMI 配置。');
    return { gameId:game, root:data.root, mods:mods.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')), warnings, loaderMatched, excludeMatched, characters:[...new Set([...INITIAL_CHARACTERS[game],...data.groups.character,...mods.map(mod=>mod.metadata.character).filter(Boolean)])], categories:[...new Set([...data.groups.category,...mods.map(mod=>mod.metadata.category).filter(Boolean)])], appearances:[...new Set([...data.groups.appearance,...mods.map(mod=>mod.metadata.appearance).filter(Boolean)])] };
  }
  async operate(game: GameId, id: string, operation: ModOperation): Promise<LibrarySnapshot> {
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id);
    if (!operation || typeof operation!=='object') throw new Error('操作格式无效。');
    if (operation.kind==='metadata') record.metadata=validateMetadata(operation.metadata);
    else {
      let destination=directory; const leaf=path.basename(directory); const base=clean(leaf);
      if (operation.kind==='toggle') {
        if (typeof operation.enabled!=='boolean') throw new Error('启停状态无效。');
        const ancestors=record.relativePath.split(path.sep).slice(0,-1).filter(disabled);
        if (operation.enabled && (ancestors.length || disabled(path.basename(data.root)))) throw new Error('父分类目录已停用。请先移动到启用分类，不能仅改名内层目录来启用。');
        destination=path.join(path.dirname(directory),operation.enabled?base:`DISABLED_${base}`);
      } else if (operation.kind==='rename') destination=path.join(path.dirname(directory),(disabled(leaf)?'DISABLED_':'')+safeName(operation.name));
      else if (operation.kind==='classify') {
        const labels={category:safeName(operation.category,true),character:safeName(operation.character,true),appearance:safeName(operation.appearance,true)};
        const parts=[labels.category,labels.character,labels.appearance].filter(Boolean);
        if (parts.some(disabled)) throw new Error('分类名称不能使用 DISABLED 前缀。');
        destination=containedPath(data.root,[...parts,leaf].join(path.sep)); record.metadata={...record.metadata,...labels};
      } else throw new Error('不支持的 Mod 操作。');
      if(operation.kind==='rename'&&destination!==directory&&destination.toLowerCase()===directory.toLowerCase()){
        await assertNoLinks(destination);await fs.rename(directory,destination);record.relativePath=path.relative(data.root,destination);
      } else if (destination.toLowerCase()!==directory.toLowerCase()) {
        if (relation(directory,destination)) throw new Error('目标不能位于 Mod 自身目录内。');
        await assertNoLinks(destination); if(await present(destination)) throw new Error('目标已有同名 Mod，未覆盖。');
        const boundaries = await discover(data.root, new Set(Object.values(data.records).filter(item=>!item.deleted).map(item=>item.relativePath)));
        if (boundaries.some(relative=>relative!==record.relativePath && relation(path.join(data.root,relative).toLowerCase(),destination.toLowerCase()))) throw new Error('目标位于另一个 Mod 内部，不能把分类目录放入它的资源树。');
        await fs.mkdir(path.dirname(destination),{recursive:true}); await fs.rename(directory,destination); record.relativePath=path.relative(data.root,destination);
      }
    }
    await this.save(game,data); return this.scan(game);
  }
  async import(game: GameId, sources: string[]): Promise<ImportResult> {
    const data=await this.load(game); const ids:string[]=[]; const errors:string[]=[];
    for(const source of sources) {
      let destination='';
      try {
        await assertNoLinks(source); const stat=await fs.stat(source);
        if(relation(data.root,source) || relation(source,data.root)) throw new Error('来源与已管理目录重叠，不能重复导入。');
        let input=source; let sourceName=path.basename(source,path.extname(source));
        if(stat.isFile()) { const parent=path.join(this.dataDirectory,'imports'); await fs.mkdir(parent,{recursive:true}); const temporary=await fs.mkdtemp(path.join(parent,'archive-')); await extractModArchive(source,temporary); input=temporary; }
        else if(!stat.isDirectory()) throw new Error('来源不是目录或受支持压缩包。');
        else sourceName=path.basename(source);
        let candidates=await discover(input);
        const rootEntries=await fs.readdir(input,{withFileTypes:true}); const rootIni=rootEntries.some(entry=>entry.isFile()&&modIni(entry.name));
        if(rootIni) candidates=[''];
        if(!candidates.length) throw new Error('没有发现包含 INI 的 Mod。');
        for(const candidate of candidates) {
          const from=candidate?path.join(input,candidate):input;
          const name=safeName(candidate?path.basename(candidate):sourceName);
          destination=path.join(data.root,name);
          await copyDirectory(from,destination);
          const id=randomUUID(); const relativePath=path.relative(data.root,destination);
          data.records[id]={id,relativePath,metadata:inferred(game,candidate||name,data.groups.category)}; ids.push(id); destination='';
        }
      } catch(error) {
        if(destination && relation(data.root,destination) && await present(destination)) {
          // Do not remove an existing collision. Partial copies remain explicitly reported for inspection.
        }
        errors.push(`${path.basename(source)}：${(error as Error).message}`);
      }
    }
    await this.save(game,data); return {library:await this.scan(game),importedIds:ids,errors,canceled:false};
  }
  async delete(game:GameId,id:string):Promise<LibrarySnapshot> {
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id);
    const recovery=await new RecoveryStore(this.dataDirectory).create(game,{root:data.root,kind:'mod-delete',name:clean(path.basename(directory)),relativePath:record.relativePath,modId:id,record,includesContent:true},target=>copyDirectory(directory,target));
    await fs.rm(directory,{recursive:true}); record.deleted=recovery.id; await this.save(game,data); return this.scan(game);
  }
  async replace(game:GameId,id:string,source:string):Promise<LibrarySnapshot> {
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id); await assertNoLinks(source);
    if(relation(directory,source)||relation(source,directory)||relation(data.root,source)) throw new Error('替换来源与已管理目录重叠。');
    const workRoot=path.join(this.dataDirectory,'replacements'); await fs.mkdir(workRoot,{recursive:true}); const work=await fs.mkdtemp(path.join(workRoot,'replace-'));
    let input=source; const stat=await fs.stat(source); if(stat.isFile()) { input=path.join(work,'unpacked'); await extractModArchive(source,input); }
    if(!await hasIni(input)) throw new Error('替换来源没有 Mod INI。');
    const entries=await fs.readdir(input,{withFileTypes:true}); const direct=entries.some(entry=>entry.isFile()&&modIni(entry.name));
    if(!direct) { const candidates=await discover(input); if(candidates.length!==1) throw new Error('替换压缩包或目录必须只包含一个明确的 Mod。'); input=path.join(input,candidates[0]); }
    const payload=path.join(work,'payload'); await copyDirectory(input,payload);
    // Preserve a chosen cover independently of replacement content and all registry metadata/disabled state.
    if(record.cover && await present(containedPath(directory,record.cover)) && (record.cover.startsWith('.kmm-cover') || !await present(containedPath(payload,record.cover)))) { const oldCover=containedPath(directory,record.cover); const newCover=containedPath(payload,record.cover); await assertNoLinks(oldCover); await assertNoLinks(newCover); await fs.copyFile(oldCover,newCover); }
    const recoveryItem=await new RecoveryStore(this.dataDirectory).create(game,{root:data.root,kind:'mod-replace',name:clean(path.basename(directory)),relativePath:record.relativePath,modId:id,record,includesContent:true},target=>copyDirectory(directory,target));
    const recovery=path.join(this.dataDirectory,'removed',game,recoveryItem.id);
    await fs.rm(directory,{recursive:true});
    try { await copyDirectory(payload,directory); } catch(error) { if(await present(directory)) await fs.rm(directory,{recursive:true}); await copyDirectory(recovery,directory); throw error; }
    await this.save(game,data); return this.scan(game);
  }
  async cover(game:GameId,id:string):Promise<string|null> {
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id); if(!record.cover) return null;
    const target=containedPath(directory,record.cover); await assertNoLinks(target); const stat=await fs.stat(target); if(stat.size>10*1024**2) throw new Error('预览图超过10MB。');
    const ext=path.extname(target).toLowerCase(); const type:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
    if(!type[ext]) throw new Error('预览仅支持PNG、JPEG、WebP、GIF。'); return `data:${type[ext]};base64,${(await fs.readFile(target)).toString('base64')}`;
  }
  async setCover(game:GameId,id:string,source:string):Promise<LibrarySnapshot> {
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id); const ext=path.extname(source).toLowerCase(); if(!['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)) throw new Error('请选择支持的本地图片。');
    await assertNoLinks(source); if((await fs.stat(source)).size>10*1024**2) throw new Error('预览图超过10MB。'); const name='.kmm-cover'+ext; const target=path.join(directory,name); await assertNoLinks(target); if(source.toLowerCase()!==target.toLowerCase()) await fs.copyFile(source,target); record.cover=name; await this.save(game,data); return this.scan(game);
  }
  async addGroup(game:GameId,kind:'category'|'character'|'appearance',name:string):Promise<LibrarySnapshot> {
    const data=await this.load(game); if(!['category','character','appearance'].includes(kind)) throw new Error('分类类型无效。'); const label=safeName(name); if(!data.groups[kind].includes(label)) data.groups[kind].push(label); await this.save(game,data); return this.scan(game);
  }
}
