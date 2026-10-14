import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { GameId, GAMES, GamePaths, LibrarySnapshot, ModEntry, ModMetadata, ModOperation, ImportResult,ModProvenance,ExclusiveGroup,ExclusiveChoices,BatchModOperation,BatchModResult,BatchModItem } from '../shared/contracts';
import { INITIAL_CHARACTERS, CHARACTER_ALIASES } from '../shared/characters';
import { assertNoLinks, containedPath } from './archive';
import { extractModArchive } from './mod-archive';
import { inspectXXMI } from './xxmi';
import { RecoveryStore } from './recovery';
import {emptyProvenance,editableProvenance} from '../shared/mod-provenance';
import {readProvenance,updateProvenance} from './mod-provenance';
import {exclusiveRequests} from './exclusive-groups';
import type {GameBananaDownload} from './gamebanana';
import type {ModRemoteInfo,ModDownloadInstallItem,ModDownloadInstallPlan,ModInstallDestination} from '../shared/contracts';
import {readRemoteInfo,readDownloadBinding,verifyModDownload,ModDirectoryChangedError} from './gamebanana';
import {writeAtomicFile,writeAtomicJson} from './atomic-json';
import {ImageCache} from './image-cache';
import {FileOperations} from './file-operations';
import {normalizeTags,readRequirements} from '../shared/mod-library';
import {Dependencies,dependencyOrder,installedVersions,validateDependencyGraph} from './dependencies';
import type {ModRequirements,DependencyConfirmation,DependencyRequest,ActiveProfile,ModUpdateTarget} from '../shared/contracts';
export interface RecordEntry { id: string; relativePath: string; metadata: ModMetadata; provenance?:ModProvenance; remote?:ModRemoteInfo; cover?: string; deleted?: string;favorite?:boolean;tags?:string[];contentRevision?:string;requirements?:ModRequirements }
export interface LibraryData { version: 1; root: string; records: Record<string, RecordEntry>; groups: { category: string[]; character: string[]; appearance: string[] }; characterCovers?:Record<string,string>;exclusiveGroups?:ExclusiveGroup[];activeProfile?:ActiveProfile }
export function validateRestoreRegistry(value:LibraryData){
 if(!value||value.version!==1||typeof value.root!=='string'||!path.isAbsolute(value.root)||!value.records||typeof value.records!=='object'||Array.isArray(value.records)||Object.keys(value.records).length>20000||!value.groups)throw new Error('备份库格式无效。');
 for(const kind of ['category','character','appearance']as const)if(!Array.isArray(value.groups[kind])||value.groups[kind].length>10000||value.groups[kind].some(name=>safeName(name)!==name))throw new Error('备份分类无效。');
 for(const [id,record]of Object.entries(value.records)){if(!record||record.id!==id||typeof record.relativePath!=='string')throw new Error('备份 Mod 身份无效。');const directory=containedPath(value.root,record.relativePath);validateMetadata(record.metadata);readProvenance(record.provenance);if(record.cover)containedPath(directory,record.cover);if(record.remote)readRemoteInfo(record.remote);if(record.favorite!==undefined&&typeof record.favorite!=='boolean')throw new Error('备份收藏数据无效。');if(record.tags)normalizeTags(record.tags);if(record.requirements)readRequirements(record.requirements);if(record.contentRevision!==undefined&&(typeof record.contentRevision!=='string'||!record.contentRevision))throw new Error('备份内容身份无效。');}
 const active=value.activeProfile;if(active){if(!/^[a-f0-9-]{36}$/.test(active.presetId)||!/^[a-f0-9-]{36}$/.test(active.revision)||!active.members||typeof active.members!=='object'||Array.isArray(active.members)||Object.keys(active.members).length>5000||Object.values(active.members).some(v=>typeof v!=='boolean')||!Array.isArray(active.files)||active.files.length>2048)throw new Error('备份活动配置无效。');for(const file of active.files){if(typeof file.modId!=='string'||typeof file.relativePath!=='string'||!/\.ini$/i.test(file.relativePath)||! /^[a-f0-9]{64}$/.test(file.digest))throw new Error('备份活动配置文件无效。');containedPath(value.root,file.relativePath);}}
 if(value.exclusiveGroups!==undefined){if(!Array.isArray(value.exclusiveGroups))throw new Error('备份互斥组无效。');const groups=new Set<string>(),members=new Set<string>();for(const group of value.exclusiveGroups){if(!group||typeof group.id!=='string'||groups.has(group.id)||safeName(group.name)!==group.name||!Array.isArray(group.modIds)||group.modIds.length<2||group.modIds.some(id=>typeof id!=='string'||!Object.hasOwn(value.records,id)||members.has(id)))throw new Error('备份互斥组无效。');groups.add(group.id);for(const id of group.modIds){if(members.has(id))throw new Error('备份互斥组包含重复成员。');members.add(id);}}}
 return value;
}
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
export function selectedModIds(ids:unknown):string[] {
 if(!Array.isArray(ids)||!ids.length||ids.length>5000||ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw new Error('请选择 1–5000 个不重复的 Mod 身份。');return ids;
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
    for (const entry of entries) if (entry.isDirectory() && !entry.isSymbolicLink() && !clean(entry.name).startsWith('.') && !resourceNames.has(clean(entry.name).toLowerCase())) await walk(path.join(directory, entry.name), depth + 1);
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
async function mapLimit<T,U>(items:T[],limit:number,work:(item:T)=>Promise<U>):Promise<U[]>{const results:U[]=[];let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{for(;;){const index=cursor++;if(index>=items.length)return;results[index]=await work(items[index]);}}));return results;}
export class ModService {
  updateProfiles?:{context:(game:GameId)=>Promise<unknown>;rebase:(game:GameId,data:LibraryData,record:RecordEntry,payload:string)=>Promise<import('./file-operations').MetadataChange[]>};
  private dependencies=new Dependencies();
  async dependencyCheck(game:GameId,request:DependencyRequest){const library=await this.scan(game);const config=await this.paths(game);return this.dependencies.plan(library,await installedVersions(game,config.xxmiRoot),this.projectRequest(library,request));}
  private projectRequest(library:LibrarySnapshot,request:DependencyRequest){const states={...request.states};for(const group of library.exclusiveGroups){const chosen=group.modIds.filter(id=>states[id]===true);if(chosen.length===1)for(const id of group.modIds)if(id!==chosen[0]&&library.mods.some(m=>m.id===id))states[id]=false;}return {...request,states};}
  async readonlyDependencyPlan(game:GameId,library:LibrarySnapshot,request:DependencyRequest,xxmiRoot?:string){const config=await this.paths(game);return new Dependencies().plan(library,await installedVersions(game,xxmiRoot??config.xxmiRoot),this.projectRequest(library,request));}
  async checkedStates(game:GameId,library:LibrarySnapshot,request:DependencyRequest,confirmation?:DependencyConfirmation,xxmiRoot?:string){const config=await this.paths(game);return this.dependencies.check(library,await installedVersions(game,xxmiRoot??config.xxmiRoot),this.projectRequest(library,request),confirmation);}
  async writeRegistry(game:GameId,data:LibraryData){await this.save(game,data);}
  async restoredProjection(game:GameId,data:LibraryData){validateRestoreRegistry(data);const library=await this.readonlyScan(game);return {...library,exclusiveGroups:data.exclusiveGroups||[],mods:Object.values(data.records).filter(record=>!record.deleted).map(record=>{containedPath(data.root,record.relativePath);record.metadata=validateMetadata(record.metadata);if(record.favorite!==undefined&&typeof record.favorite!=='boolean')throw new Error('备份收藏数据无效。');if(record.tags!==undefined)record.tags=normalizeTags(record.tags);const parts=record.relativePath.split(path.sep),ownDisabled=disabled(parts.at(-1)!);return {id:record.id,name:clean(parts.at(-1)!),relativePath:record.relativePath,metadata:record.metadata,provenance:readProvenance(record.provenance),requirements:record.requirements?readRequirements(record.requirements):undefined,contentRevision:record.contentRevision,enabled:!ownDisabled&&!parts.slice(0,-1).some(disabled)&&!disabled(path.basename(data.root)),ownDisabled,disabledAncestors:parts.slice(0,-1).filter(disabled),hasCover:false,iniCount:0};})};}
  private images=new ImageCache();
  private snapshots=new Map<GameId,{data:string;library:LibrarySnapshot}>();
  private operations:FileOperations;
  private initialized=new WeakSet<LibraryData>();
  constructor(private dataDirectory: string, private paths: (game: GameId) => Promise<GamePaths>) {this.operations=new FileOperations(dataDirectory);}
  private async commit(game:GameId,data:LibraryData,name:string,changes:Parameters<FileOperations['run']>[3]){await this.operations.run(game,data.root,name,changes,[{target:this.file(game),bytes:JSON.stringify(data,null,2)}]);this.snapshots.delete(game);}
  async coverCatalog(game:GameId){const data=await this.load(game);const cached=this.snapshots.get(game);return cached?.data===JSON.stringify(data)?cached.library.characters:(await this.scan(game)).characters;}
  async characterCoverReferences(game:GameId){return (await this.load(game)).characterCovers||{};}
  async setCharacterCoverReference(game:GameId,name:string,file:string){const data=await this.load(game);data.characterCovers={...data.characterCovers,[name]:file};await this.save(game,data);}
  async context(game:GameId,id?:string){const data=await this.load(game);return {data,...(id?await this.resolve(data,id):{record:undefined,directory:data.root})};}
  async recoverRecord(game:GameId,input:unknown){const data=await this.load(game);const record=input as RecordEntry;if(!record||typeof record.id!=='string'||!record.relativePath)throw new Error('恢复元数据格式无效。');containedPath(data.root,record.relativePath);record.metadata=validateMetadata(record.metadata);if(record.provenance)record.provenance=readProvenance(record.provenance);if(record.remote)record.remote=readRemoteInfo(record.remote);delete record.deleted;data.records[record.id]=record;await this.save(game,data);const snapshot=await this.scan(game);if(snapshot.mods.find(mod=>mod.id===record.id)?.enabled&&snapshot.exclusiveGroups.some(group=>group.modIds.includes(record.id)))return this.operate(game,record.id,{kind:'toggle',enabled:true},snapshot);return snapshot;}
  private file(game: GameId) { if (!Object.hasOwn(GAMES, game)) throw new Error('不支持的游戏。'); return path.join(this.dataDirectory, `library-${game}.json`); }
  private async load(game: GameId,readOnly=false): Promise<LibraryData> {
    this.file(game);
    const config = await this.paths(game); const root = config.modsDirectory;
    if (!root || !path.isAbsolute(root)) throw new Error('请先在路径与加载器中保存该游戏的 Mod 目录。');
    if(path.resolve(root).toLowerCase()===path.parse(path.resolve(root)).root.toLowerCase())throw new Error('Mod 目录不能直接使用磁盘根目录，请选择专用文件夹。');
    await this.operations.assertReady(game,root);
    await assertNoLinks(root);
    if (!(await fs.stat(root)).isDirectory()) throw new Error('已保存的 Mod 目录不存在，请检查路径。');
    let data: LibraryData | undefined;
    try { data = JSON.parse(await fs.readFile(this.file(game), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Mod 元数据配置无法读取，原文件已保留。'); }
    if (data && (data.version !== 1 || !data.records || !data.groups || typeof data.root !== 'string')) throw new Error('Mod 元数据配置格式无效，原文件已保留。');
    if (!data || data.root.toLowerCase() !== root.toLowerCase()) {if(data&&!readOnly){const archived=path.join(this.dataDirectory,'root-history',game);await fs.mkdir(archived,{recursive:true});await writeAtomicJson(path.join(archived,randomUUID()+'.json'),JSON.stringify(data,null,2));}data = { version:1, root, records:{}, groups:{ category:[...initialCategories], character:[], appearance:[] } };if(!readOnly)this.initialized.add(data);}
    for(const record of Object.values(data.records)){if(record.favorite!==undefined&&typeof record.favorite!=='boolean')throw new Error('收藏数据无效。');if(record.tags!==undefined)record.tags=normalizeTags(record.tags);if(record.requirements!==undefined)record.requirements=readRequirements(record.requirements);if(record.contentRevision!==undefined&&(typeof record.contentRevision!=='string'||!record.contentRevision))throw new Error('内容版本身份无效。');}
    if(data.activeProfile){const active=data.activeProfile;if(!/^[a-f0-9-]{36}$/.test(active.presetId)||!/^[a-f0-9-]{36}$/.test(active.revision)||!active.members||typeof active.members!=='object'||Array.isArray(active.members)||Object.keys(active.members).length>5000||Object.values(active.members).some(value=>typeof value!=='boolean')||!Array.isArray(active.files)||active.files.length>2048)throw new Error('活动配置关联无效。');for(const file of active.files){if(typeof file.modId!=='string'||typeof file.relativePath!=='string'||!/\.ini$/i.test(file.relativePath)||! /^[a-f0-9]{64}$/.test(file.digest))throw new Error('活动配置文件关联无效。');containedPath(data.root,file.relativePath);}}
    if(data.exclusiveGroups!==undefined){
      if(!Array.isArray(data.exclusiveGroups))throw new Error('互斥组配置格式无效，原文件已保留。');
      const groups=new Set<string>();const members=new Set<string>();
      for(const group of data.exclusiveGroups){if(!group||typeof group.id!=='string'||!group.id||groups.has(group.id)||safeName(group.name)!==group.name||!Array.isArray(group.modIds)||group.modIds.length<2||group.modIds.some(id=>typeof id!=='string'||!Object.hasOwn(data!.records,id)||members.has(id)))throw new Error('互斥组配置格式无效，原文件已保留。');groups.add(group.id);for(const id of group.modIds){if(members.has(id))throw new Error('Mod 不能属于多个互斥组。');members.add(id);}}
    }
    return data;
  }
  private async save(game: GameId, data: LibraryData) { await writeAtomicJson(this.file(game),JSON.stringify(data,null,2));this.snapshots.delete(game); }
  private async resolve(data: LibraryData, id: string): Promise<{record: RecordEntry; directory: string}> {
    if (typeof id !== 'string' || !Object.hasOwn(data.records, id) || data.records[id].deleted) throw new Error('Mod 不存在，请重新扫描。');
    const record = data.records[id]; const directory = containedPath(data.root, record.relativePath); await assertNoLinks(directory);
    if (!(await fs.stat(directory)).isDirectory()) throw new Error('Mod 目录已变化，请重新扫描。');
    return { record, directory };
  }
  private async makeEntry(data: LibraryData, record: RecordEntry,budget?:{nodes:number;signal?:AbortSignal}): Promise<ModEntry> {
    const directory = containedPath(data.root, record.relativePath); const parts = record.relativePath.split(path.sep);
    const entries=await fs.readdir(directory,{withFileTypes:true});const covers=entries.find(entry=>entry.isFile()&&/^((\.kmm-cover|cover|preview|thumbnail|_cover)\.(png|jpe?g|webp|gif))$/i.test(entry.name))?.name;
    const ownDisabled = disabled(parts.at(-1)!); const disabledAncestors = parts.slice(0, -1).filter(disabled);
    const rootDisabled = disabled(path.basename(data.root)); if (rootDisabled) disabledAncestors.unshift(path.basename(data.root));
    let iniCount = 0;
    const count = async (folder: string,files=entries,depth=0) => { if(budget&&depth>32)throw new Error('只读目录深度超出预算。');for (const entry of files) {if(budget){budget.signal?.throwIfAborted();if(++budget.nodes>200000)throw new Error('只读文件数量超出预算。');} if (entry.isFile() && modIni(entry.name)) iniCount++; if (entry.isDirectory() && !entry.isSymbolicLink()) await count(path.join(folder, entry.name),await fs.readdir(path.join(folder,entry.name),{withFileTypes:true}),depth+1); } }; await count(directory);
    if (!record.cover && covers) record.cover = covers;
    record.contentRevision??=randomUUID();
    return { id:record.id, name:clean(parts.at(-1)!), relativePath:record.relativePath, metadata:record.metadata,provenance:readProvenance(record.provenance), ...(record.remote?{remote:readRemoteInfo(record.remote)}:{}),favorite:record.favorite||false,tags:record.tags||[],contentRevision:record.contentRevision,requirements:record.requirements, enabled:!ownDisabled && !disabledAncestors.length, ownDisabled, disabledAncestors, hasCover:!!record.cover && await present(containedPath(directory, record.cover)), iniCount };
  }
  async readonlyContext(game:GameId,id?:string){const data=await this.load(game,true);return {data,...(id?await this.resolve(data,id):{record:undefined,directory:data.root})};}
  async readonlyScan(game:GameId,signal?:AbortSignal){return this.scan(game,true,signal);}
  async scan(game: GameId,readOnly=false,signal?:AbortSignal): Promise<LibrarySnapshot> {
    const data = await this.load(game,readOnly); const relativePaths = await discover(data.root, new Set(Object.values(data.records).filter(record=>!record.deleted).map(record=>record.relativePath)));
    const before=JSON.stringify(data);const byPath=new Map<string,RecordEntry>();for(const record of Object.values(data.records))if(!record.deleted&&!byPath.has(record.relativePath))byPath.set(record.relativePath,record);
    const records:RecordEntry[]=[];
    for (const relativePath of relativePaths) {
      let record = byPath.get(relativePath);
      if (!record) { const id=readOnly?'unindexed:'+relativePath:randomUUID(); record={id, relativePath, metadata:inferred(game, relativePath,data.groups.category)}; data.records[id]=record; }
      records.push(record);
    }
    const budget=readOnly?{nodes:0,signal}:undefined;const mods=await mapLimit(records,readOnly?4:12,record=>this.makeEntry(data,record,budget));
    if(!readOnly&&(this.initialized.has(data)||before!==JSON.stringify(data)))await this.save(game, data);
    const warnings: string[]=[]; let loaderMatched=false; let excludeMatched=false;
    const config=await this.paths(game);
    try {
      const inspection=await inspectXXMI(game, config.xxmiRoot); loaderMatched=inspection.modsDirectories.some(directory=>relation(directory.toLowerCase(), data.root.toLowerCase()));
      if (inspection.importerExists) { const ini=await fs.readFile(inspection.iniPath,'utf8'); excludeMatched=/^\s*exclude_recursive\s*=\s*DISABLED\*\s*(?:;.*)?$/im.test(ini); }
    } catch { /* reports the missing loader below */ }
    if (!loaderMatched) warnings.push('当前 Mod 目录不在所选 loader 已确认的读取范围。管理操作仍可保存，但不代表游戏会加载；请到路径与加载器同步目录。');
    if (!excludeMatched) warnings.push('未确认 loader 的 exclude_recursive = DISABLED* 规则。目录停用不代表游戏已停用，请检查 XXMI 配置。');
    for(const group of data.exclusiveGroups||[])if(mods.filter(mod=>group.modIds.includes(mod.id)&&mod.enabled).length>1)warnings.push(`互斥组“${group.name}”有多个实际启用成员，请明确选择一个启用。`);
    const library={ gameId:game, root:data.root, mods:mods.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')),exclusiveGroups:data.exclusiveGroups||[], warnings, loaderMatched, excludeMatched, characters:[...new Set([...INITIAL_CHARACTERS[game],...data.groups.character,...mods.map(mod=>mod.metadata.character).filter(Boolean)])], categories:[...new Set([...data.groups.category,...mods.map(mod=>mod.metadata.category).filter(Boolean)])], appearances:[...new Set([...data.groups.appearance,...mods.map(mod=>mod.metadata.appearance).filter(Boolean)])] };
    if(!readOnly)this.snapshots.set(game,{data:JSON.stringify(data),library});return library;
  }
  private async preflightToggle(data:LibraryData,id:string,enabled:boolean){
    const {record,directory}=await this.resolve(data,id);
    if(enabled&&(record.relativePath.split(path.sep).slice(0,-1).some(disabled)||disabled(path.basename(data.root))))throw new Error('父分类目录已停用。请先移动到启用分类，不能仅改名内层目录来启用。');
    const destination=path.join(path.dirname(directory),enabled?clean(path.basename(directory)):`DISABLED_${clean(path.basename(directory))}`);
    await assertNoLinks(destination);if(destination.toLowerCase()!==directory.toLowerCase()&&await present(destination))throw new Error('目标已有同名 Mod，未覆盖。');
  }
  private async switchExclusive(game:GameId,id:string,members:string[],current?:LibrarySnapshot):Promise<LibrarySnapshot>{
    const snapshot=current||await this.scan(game);const data=await this.load(game);await this.preflightToggle(data,id,true);
    const peers=snapshot.mods.filter(mod=>mod.id!==id&&members.includes(mod.id)&&mod.enabled);
    for(const peer of peers)await this.preflightToggle(data,peer.id,false);
    const changed:string[]=[];
    try{let result=snapshot;for(const peer of peers){result=await this.operateDirect(game,peer.id,{kind:'toggle',enabled:false},result);changed.push(peer.id);}const final=await this.operateDirect(game,id,{kind:'toggle',enabled:true},result);return current?final:this.scan(game);}
    catch(error){const issues:string[]=[];const target=snapshot.mods.find(mod=>mod.id===id);if(target&&!target.enabled){try{await this.operateDirect(game,id,{kind:'toggle',enabled:false});}catch(e){issues.push((e as Error).message);}}
      for(const peer of changed.reverse())try{await this.operateDirect(game,peer,{kind:'toggle',enabled:true});}catch(e){issues.push((e as Error).message);}
      throw new Error(`${(error as Error).message}${issues.length?'；回退未完成，请重新扫描核对：'+issues.join('；'):''}`);
    }
  }
  async operate(game:GameId,id:string,operation:ModOperation,current?:LibrarySnapshot,confirmation?:DependencyConfirmation):Promise<LibrarySnapshot>{
    if(operation?.kind==='toggle'&&!current){let library=await this.scan(game);const plan=await this.checkedStates(game,library,{states:{[id]:operation.enabled}},confirmation);const changed:string[]=[];try{for(const dependent of dependencyOrder(library,plan.states).filter(key=>key!==id&&plan.dependents.includes(key))){library=await this.operateDirect(game,dependent,{kind:'toggle',enabled:false},library);changed.push(dependent);}await this.operate(game,id,operation,library);return this.scan(game);}catch(error){for(const key of changed.reverse())try{await this.operateDirect(game,key,{kind:'toggle',enabled:true});}catch{/* The recoverable file queue retains a failed move. */}throw error;}}
    if(operation?.kind==='requirements'){const snapshot=await this.scan(game);validateDependencyGraph(snapshot,id,operation.value);const mod=snapshot.mods.find(m=>m.id===id);if(mod?.enabled)await this.checkedStates(game,{...snapshot,mods:snapshot.mods.map(m=>m.id===id?{...m,requirements:readRequirements(operation.value)}:m)},{states:{[id]:true}},confirmation);}
    if(['rename','classify'].includes(operation?.kind)&&!current){const snapshot=await this.scan(game);await this.checkedStates(game,snapshot,{states:{[id]:!snapshot.mods.find(m=>m.id===id)!.ownDisabled}},confirmation);}
    if(operation?.kind==='toggle'&&operation.enabled===true){const data=await this.load(game);const group=data.exclusiveGroups?.find(group=>group.modIds.includes(id));if(group)return this.switchExclusive(game,id,group.modIds,current);}
    const result=await this.operateDirect(game,id,operation,current);
    // A move out of a disabled ancestor or a rename removing DISABLED also enables content.
    if(['classify','rename'].includes(operation.kind)&&result.mods.find(mod=>mod.id===id)?.enabled){const group=result.exclusiveGroups.find(group=>group.modIds.includes(id));if(group){const final=await this.switchExclusive(game,id,group.modIds,result);return current?final:this.scan(game);}}
    return result;
  }
  private async operateDirect(game: GameId, id: string, operation: ModOperation,current?:LibrarySnapshot): Promise<LibrarySnapshot> {
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id);
    let movement:Parameters<FileOperations['run']>[3]=[];
    if (!operation || typeof operation!=='object') throw new Error('操作格式无效。');
    if(operation.kind==='favorite'){if(typeof operation.value!=='boolean')throw new Error('收藏状态无效。');record.favorite=operation.value;}
    else if(operation.kind==='tags')record.tags=normalizeTags(operation.values);
    else if(operation.kind==='requirements')record.requirements=readRequirements(operation.value);
    else if (operation.kind==='metadata') record.metadata=validateMetadata(operation.metadata);
    else if(operation.kind==='provenance')record.provenance=updateProvenance(record.provenance,operation.fields,'edited');
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
        await assertNoLinks(destination);movement=[{kind:'move',from:directory,target:destination}];record.relativePath=path.relative(data.root,destination);
      } else if (destination.toLowerCase()!==directory.toLowerCase()) {
        if (relation(directory,destination)) throw new Error('目标不能位于 Mod 自身目录内。');
        await assertNoLinks(destination); if(await present(destination)) throw new Error('目标已有同名 Mod，未覆盖。');
        const boundaries = operation.kind==='classify'?await discover(data.root, new Set(Object.values(data.records).filter(item=>!item.deleted).map(item=>item.relativePath))):[];
        if (boundaries.some(relative=>relative!==record.relativePath && relation(path.join(data.root,relative).toLowerCase(),destination.toLowerCase()))) throw new Error('目标位于另一个 Mod 内部，不能把分类目录放入它的资源树。');
        movement=[{kind:'move',from:directory,target:destination}];record.relativePath=path.relative(data.root,destination);
      }
    }
    if(movement.length)await this.commit(game,data,`整理 ${clean(path.basename(directory))}`,movement);else await this.save(game,data);
    if(current){const entry=await this.makeEntry(data,record);return {...current,mods:current.mods.map(mod=>mod.id===id?entry:mod)};}
    return this.scan(game);
  }
  async batch(game:GameId,ids:string[],operation:BatchModOperation,choices?:ExclusiveChoices,confirmation?:DependencyConfirmation):Promise<BatchModResult>{
    selectedModIds(ids);if(!operation||!['toggle','classify'].includes(operation.kind))throw new Error('批量操作只支持启停或分类移动。');
    if(operation.kind==='toggle'){if(typeof operation.enabled!=='boolean')throw new Error('启停状态无效。');return this.applyStates(game,Object.fromEntries(ids.map(id=>[id,operation.enabled])),choices,confirmation);}
    for(const value of [operation.category,operation.character,operation.appearance]){const label=safeName(value,true);if(disabled(label))throw new Error('分类名称不能使用 DISABLED 前缀。');}
    const items:BatchModItem[]=[];let library=await this.scan(game);
    const active=library.mods.filter(mod=>ids.includes(mod.id)&&!mod.ownDisabled).map(mod=>mod.id);const plan=exclusiveRequests(library.exclusiveGroups,active,choices);
    if(plan.conflicts.length)return {library,items:[],conflicts:plan.conflicts};
    const checked=await this.checkedStates(game,library,{states:Object.fromEntries(ids.map(id=>[id,active.includes(id)&&plan.enabled.has(id)]))},confirmation);for(const key of dependencyOrder(library,checked.states).filter(key=>checked.dependents.includes(key)&&!ids.includes(key)))library=await this.operate(game,key,{kind:'toggle',enabled:false},library);
    for(const id of ids){const target=library.mods.find(mod=>mod.id===id);const name=target?.name||id;try{if(target&&!target.ownDisabled&&active.includes(id)&&!plan.enabled.has(id))library=await this.operate(game,id,{kind:'toggle',enabled:false},library);library=await this.operate(game,id,operation,library);items.push({id,name,ok:true,message:active.includes(id)&&!plan.enabled.has(id)?'按互斥选择停用后移动':undefined});}catch(error){items.push({id,name,ok:false,error:(error as Error).message});library=await this.scan(game);}}
    return {library:await this.scan(game),items,conflicts:[]};
  }
  async applyStates(game:GameId,states:Record<string,boolean>,choices?:ExclusiveChoices,confirmation?:DependencyConfirmation):Promise<BatchModResult>{
    if(!states||typeof states!=='object'||Array.isArray(states)||Object.values(states).some(value=>typeof value!=='boolean'))throw new Error('启停成员格式无效。');
    const ids=Object.keys(states);if(ids.length)selectedModIds(ids);let library=await this.scan(game);
    const plan=exclusiveRequests(library.exclusiveGroups,ids.filter(id=>states[id]&&library.mods.some(mod=>mod.id===id)),choices);
    if(plan.conflicts.length)return {library,items:[],conflicts:plan.conflicts};
    const requested=Object.fromEntries(ids.filter(id=>library.mods.some(m=>m.id===id)).map(id=>[id,plan.enabled.has(id)]));const checked=await this.checkedStates(game,library,{states:requested},confirmation);
    const items:BatchModItem[]=[];const ordered=[...dependencyOrder(library,checked.states),...ids.filter(id=>!Object.hasOwn(checked.states,id))];
    for(const id of ordered){const target=library.mods.find(mod=>mod.id===id);const name=target?.name||id;const enabled=checked.states[id]??false;
      if(!target){items.push({id,name,ok:false,error:`缺失成员：${id}`});continue;}
      try{const before=library.mods.filter(mod=>mod.enabled).map(mod=>mod.id);if(enabled?!target.enabled||library.exclusiveGroups.some(group=>group.modIds.includes(id)):!target.ownDisabled)library=await this.operate(game,id,{kind:'toggle',enabled},library);
        const disabledPeers=library.mods.filter(mod=>mod.id!==id&&before.includes(mod.id)&&!mod.enabled).map(mod=>mod.name);
        items.push({id,name,ok:true,message:states[id]&&!enabled?'按互斥选择保持停用':disabledPeers.length?`同时停用互斥成员：${disabledPeers.join('、')}`:undefined});
      }catch(error){items.push({id,name,ok:false,error:(error as Error).message});library=await this.scan(game);}
    }
    return {library:await this.scan(game),items,conflicts:[]};
  }
  async saveExclusiveGroup(game:GameId,id:string|null,name:string,modIds:string[],enabledId?:string,confirmation?:DependencyConfirmation):Promise<LibrarySnapshot>{
    selectedModIds(modIds);if(modIds.length<2)throw new Error('互斥组至少需要两个成员。');const label=safeName(name);const snapshot=await this.scan(game);
    if(id!==null&&(typeof id!=='string'||!snapshot.exclusiveGroups.some(group=>group.id===id)))throw new Error('互斥组不存在，请重新读取。');
    if(modIds.some(id=>!snapshot.mods.some(mod=>mod.id===id)))throw new Error('互斥组含缺失或其它游戏的 Mod。');
    if(snapshot.exclusiveGroups.some(group=>group.id!==id&&group.modIds.some(member=>modIds.includes(member))))throw new Error('一个 Mod 只能属于一个互斥组，请先从原组移除。');
    if(enabledId!==undefined&&(typeof enabledId!=='string'||!modIds.includes(enabledId)))throw new Error('选择的启用成员不属于互斥组。');
    if(enabledId===undefined&&snapshot.mods.filter(mod=>modIds.includes(mod.id)&&mod.enabled).length>1)throw new Error('所选成员中有多个已启用 Mod，请明确选择保存时启用的成员。');
    if(enabledId!==undefined){const checked=await this.checkedStates(game,snapshot,{states:Object.fromEntries(modIds.map(key=>[key,key===enabledId]))},confirmation);const changed:string[]=[];try{let current=snapshot;for(const dependent of dependencyOrder(snapshot,checked.states).filter(key=>checked.dependents.includes(key)&&!modIds.includes(key))){current=await this.operateDirect(game,dependent,{kind:'toggle',enabled:false},current);changed.push(dependent);}await this.switchExclusive(game,enabledId,modIds,current);}catch(error){for(const key of changed.reverse())try{await this.operateDirect(game,key,{kind:'toggle',enabled:true});}catch{/* Failed file operations remain recoverable. */}throw error;}}
    const data=await this.load(game);const group={id:id||randomUUID(),name:label,modIds:[...modIds]};data.exclusiveGroups=[...(data.exclusiveGroups||[]).filter(item=>item.id!==id),group];await this.save(game,data);return this.scan(game);
  }
  async deleteExclusiveGroup(game:GameId,id:string):Promise<LibrarySnapshot>{const data=await this.load(game);if(typeof id!=='string'||!data.exclusiveGroups?.some(group=>group.id===id))throw new Error('互斥组不存在，请重新读取。');data.exclusiveGroups=data.exclusiveGroups.filter(group=>group.id!==id);await this.save(game,data);return this.scan(game);}
  async sourceUrl(game:GameId,id:string):Promise<string>{const {record}=await this.context(game,id);const url=readProvenance(record!.provenance).sourceUrl;if(!url)throw new Error('尚未保存该 Mod 的来源地址。');return url;}
  async import(game: GameId, sources: string[]): Promise<ImportResult> {
    const data=await this.load(game); const ids:string[]=[]; const errors:string[]=[];
    for(const source of sources) {
      let temporary='';
      try {
        await assertNoLinks(source);const stat=await fs.stat(source);
        if(relation(data.root,source)||relation(source,data.root))throw new Error('来源与已管理目录重叠，不能重复导入。');
        let input=source,sourceName=path.basename(source,path.extname(source));
        if(stat.isFile()){const parent=path.join(this.dataDirectory,'imports');await fs.mkdir(parent,{recursive:true});temporary=await fs.mkdtemp(path.join(parent,'archive-'));await extractModArchive(source,temporary);input=temporary;}
        else if(!stat.isDirectory())throw new Error('来源不是目录或受支持压缩包。');else sourceName=path.basename(source);
        let candidates=await discover(input);if((await fs.readdir(input,{withFileTypes:true})).some(entry=>entry.isFile()&&modIni(entry.name)))candidates=[''];
        if(!candidates.length)throw new Error('没有发现包含 INI 的 Mod。');
        for(const candidate of candidates){
          const name=safeName(candidate?path.basename(candidate):sourceName),destination=path.join(data.root,name),id=randomUUID();
          if(await present(destination)){errors.push(name+'：目标已有同名目录，原内容保持。');continue;}
          data.records[id]={id,relativePath:name,metadata:inferred(game,candidate||name,data.groups.category),provenance:emptyProvenance(new Date().toISOString())};
          try{await this.commit(game,data,'导入 '+name,[{kind:'swap',target:destination,source:candidate?path.join(input,candidate):input,newOnly:true}]);ids.push(id);}
          catch(error){delete data.records[id];errors.push(name+'：'+(error as Error).message);if((await this.operations.list(game)).some(item=>item.kind==='interrupted'))break;}
        }
      }catch(error){errors.push(path.basename(source)+'：'+(error as Error).message);}
      finally{if(temporary){await assertNoLinks(temporary);await fs.rm(temporary,{recursive:true}).catch(()=>{});}}
    }
    return {library:await this.scan(game),importedIds:ids,errors,canceled:false};
  }
  private async unpackDownload(game:GameId,file:string,root:string,input:GameBananaDownload) {
    const binding=readDownloadBinding(input,game);
    const current=(await this.paths(game)).modsDirectory;
    if(!current||!root||path.resolve(current).toLowerCase()!==path.resolve(root).toLowerCase())throw new ModDirectoryChangedError();
    await verifyModDownload(file,binding);
    const data=await this.load(game);
    if(relation(data.root,file)||relation(file,data.root))throw new Error('下载缓存与 Mod 目录重叠，请设置独立的 Mod 目录。');
    const parent=path.join(this.dataDirectory,'imports');await fs.mkdir(parent,{recursive:true});
    const unpacked=await fs.mkdtemp(path.join(parent,'web-'));
    try {
      await extractModArchive(file,unpacked);let candidates=await discover(unpacked);
      if((await fs.readdir(unpacked,{withFileTypes:true})).some(entry=>entry.isFile()&&modIni(entry.name)))candidates=[''];
      if(!candidates.length)throw new Error('没有发现包含 INI 的 Mod。');
      return {unpacked,candidates,binding};
    }catch(error){await fs.rm(unpacked,{recursive:true}).catch(()=>{});throw error;}
  }
  private characterFor(game:GameId,value:string) {
    const exact=CHARACTER_ALIASES[game][clean(value).toLowerCase().replace(/[\s_.-]+/g,'')]||INITIAL_CHARACTERS[game].find(name=>name===clean(value));
    if(exact)return exact;
    const matches=new Set<string>();
    const words=value.toLowerCase().replace(/[_.-]+/g,' ');
    for(const [alias,character]of Object.entries(CHARACTER_ALIASES[game]))if(new RegExp(`(^|[^a-z0-9])${alias}($|[^a-z0-9])`,'i').test(words)||words.replace(/\s/g,'')===alias)matches.add(character);
    const chinese=INITIAL_CHARACTERS[game].filter(name=>name.length>1&&value.includes(name));
    for(const character of chinese.filter(name=>!chinese.some(other=>other!==name&&other.includes(name))))matches.add(character);
    return matches.size===1?[...matches][0]:'';
  }
  private async downloadPlan(game:GameId,root:string,candidates:string[],binding:GameBananaDownload,snapshot:LibrarySnapshot):Promise<ModDownloadInstallPlan> {
    const folders=[''];let examined=0;
    const walk=async(folder:string,depth:number)=>{
      if(depth>16||++examined>20000)throw new Error('分类目录过多或过深，请整理 Mod 目录。');
      const directory=folder?containedPath(root,folder):root;await assertNoLinks(directory);
      for(const entry of await fs.readdir(directory,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink()&&!entry.name.startsWith('.')&&!resourceNames.has(clean(entry.name).toLowerCase())){
        const relative=path.join(folder,entry.name);
        if(snapshot.mods.some(mod=>mod.relativePath.toLowerCase()===relative.toLowerCase()))continue;
        folders.push(relative.replaceAll('\\','/'));await walk(relative,depth+1);
      }
    };
    await walk('',0);
    const items=candidates.map(candidate=>{
      const name=candidate?clean(path.basename(candidate)):clean(path.basename(binding.remote.fileName,path.extname(binding.remote.fileName)));
      const ancestor=inferred(game,candidate||name,snapshot.categories);
      const character=this.characterFor(game,ancestor.character)||this.characterFor(game,name)||binding.metadata.character||this.characterFor(game,binding.remote.title)||this.characterFor(game,binding.remote.fileName);
      const category=binding.metadata.category||ancestor.category||(character?'角色':'');
      const matches=character?folders.filter(folder=>this.characterFor(game,path.basename(folder))===character):[];
      const preferred=matches.filter(folder=>folder.split('/')[0]===category);
      const selected=preferred.length===1?preferred[0]:matches.length===1?matches[0]:'';
      const folder=selected||(character?[category||'角色',character].join('/'):category);
      return {entryPath:candidate.replaceAll('\\','/'),name,character,folder};
    });
    return {targetRoot:root,folders:[...new Set([...folders,...items.map(item=>item.folder)])].sort((a,b)=>a.localeCompare(b,'zh-CN')),items};
  }
  async downloadInstallPlan(game:GameId,file:string,root:string,input:GameBananaDownload):Promise<ModDownloadInstallPlan> {
    const work=await this.unpackDownload(game,file,root,input);
    try{return await this.downloadPlan(game,root,work.candidates,work.binding,await this.scan(game));}
    finally{await fs.rm(work.unpacked,{recursive:true}).catch(()=>{});}
  }
  async installDownload(game:GameId,file:string,root:string,input:GameBananaDownload,destinations?:ModInstallDestination[]):Promise<ImportResult&{items:ModDownloadInstallItem[]}> {
    const {unpacked,candidates,binding}=await this.unpackDownload(game,file,root,input);const items:ModDownloadInstallItem[]=[];const ids:string[]=[];
    try {
      const snapshot=await this.scan(game);const live=new Set(snapshot.mods.map(mod=>mod.id));
      const plan=await this.downloadPlan(game,root,candidates,binding,snapshot);
      const selected=destinations===undefined?plan.items:destinations;
      if(!Array.isArray(selected)||selected.length!==candidates.length||new Set(selected.map(item=>item?.entryPath)).size!==candidates.length||selected.some(item=>!item||typeof item.entryPath!=='string'||!plan.items.some(row=>row.entryPath===item.entryPath)||typeof item.folder!=='string'))throw new Error('安装文件夹选择与压缩包条目不匹配，请重新选择。');
      const folders=new Map(selected.map(item=>{
        if(path.isAbsolute(item.folder)||item.folder.length>4096)throw new Error('安装文件夹必须位于已保存的 Mod 目录内。');
        const folder=item.folder?item.folder.split(/[\\/]/).map(part=>safeName(part)).join(path.sep):'';
        if(folder.split(path.sep).some(part=>part.startsWith('.')||resourceNames.has(clean(part).toLowerCase())))throw new Error('请选择可管理的角色或分类文件夹，不能安装到隐藏目录或资源目录。');
        if(folder&&snapshot.mods.some(mod=>relation(containedPath(root,mod.relativePath),containedPath(root,folder))))throw new Error('不能把 Mod 安装到另一个 Mod 的内部，请选择角色或分类文件夹。');
        return [item.entryPath,folder];
      }));
      // Scan can discover external entries; use its latest registry before committing new records.
      const latest=await this.load(game);
      for(const candidate of candidates){
        const entryPath=candidate.replaceAll('\\','/');let name=candidate?clean(path.basename(candidate)):clean(path.basename(binding.remote.fileName,path.extname(binding.remote.fileName)));
        let staging='';let stagingOwned=false;let destination='';let committed=false;let id='';
        try {
          name=safeName(name);
          const existing=Object.values(latest.records).find(record=>live.has(record.id)&&record.remote?.modId===binding.remote.modId&&record.remote.fileId===binding.remote.fileId&&record.remote.entryPath===entryPath);
          if(existing){items.push({id:existing.id,name,ok:true,existing:true});continue;}
          const folder=folders.get(entryPath)!;const parent=folder?containedPath(latest.root,folder):latest.root;
          await assertNoLinks(parent);
          destination=containedPath(latest.root,path.join(folder,`DISABLED_${name}`));const enabled=containedPath(latest.root,path.join(folder,name));
          await assertNoLinks(destination);await assertNoLinks(enabled);
          if(await present(destination)||await present(enabled))throw new Error('目标已有同名 Mod，原内容保持，请改名或使用替换功能。');
          const labels=folder?inferred(game,path.join(folder,name),latest.groups.category):undefined;
          if(labels){const parts=folder.split(path.sep).map(clean);const index=parts.findIndex(part=>!!this.characterFor(game,part));if(index>=0){labels.category=index?parts.slice(0,index).join(' · '):binding.metadata.category||'角色';labels.character=this.characterFor(game,parts[index]);labels.appearance=parts.slice(index+1).join(' · ');}}
          const metadataValue=validateMetadata({...inferred(game,candidate||name,latest.groups.category),...binding.metadata,...(labels?{category:labels.category,character:labels.character,appearance:labels.appearance}:{})});
          staging=containedPath(path.dirname(latest.root),`.kmm-import-${randomUUID()}`);await assertNoLinks(staging);await fs.mkdir(staging);stagingOwned=true;
          const payload=path.join(staging,'payload');await copyDirectory(candidate?containedPath(unpacked,candidate):unpacked,payload);
          // Windows directory rename refuses an existing destination; all content is prepared first.
          await fs.mkdir(parent,{recursive:true});await assertNoLinks(parent);
          if(await present(destination)||await present(enabled))throw new Error('安装目标在准备期间出现同名内容，未覆盖。');
          id=randomUUID();
          latest.records[id]={id,relativePath:path.relative(latest.root,destination),metadata:metadataValue,provenance:{...emptyProvenance(new Date().toISOString()),sourceUrl:`https://gamebanana.com/mods/${binding.remote.modId}`,version:binding.version},remote:{...binding.remote,entryPath}};
          await this.commit(game,latest,'安装 '+name,[{kind:'swap',target:destination,source:payload,newOnly:true}]);committed=true;ids.push(id);live.add(id);items.push({id,name,ok:true});
        }catch(error){
          let message=(error as Error).message;
          if(id)delete latest.records[id];
          if(committed){try{await assertNoLinks(destination);await fs.rm(destination,{recursive:true});}catch{message+=` 新内容未能撤回，请检查：${destination}`;}}
          items.push({name,ok:false,error:message});
        }finally{if(stagingOwned)await fs.rm(staging,{recursive:true}).catch(()=>{});}
      }
      return {library:await this.scan(game),importedIds:ids,errors:items.filter(item=>!item.ok).map(item=>`${item.name}：${item.error}`),canceled:false,items};
    }finally{await fs.rm(unpacked,{recursive:true}).catch(()=>{});}
  }
  async delete(game:GameId,id:string,confirmation?:DependencyConfirmation):Promise<LibrarySnapshot> {
    const snapshot=await this.scan(game);const checked=await this.checkedStates(game,snapshot,{deleteId:id},confirmation);let current=snapshot;for(const dependent of dependencyOrder(snapshot,checked.states).filter(key=>key!==id))current=await this.operate(game,dependent,{kind:'toggle',enabled:false},current);
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id);
    const recovery=await new RecoveryStore(this.dataDirectory).create(game,{root:data.root,kind:'mod-delete',name:clean(path.basename(directory)),relativePath:record.relativePath,modId:id,record,includesContent:true},target=>copyDirectory(directory,target));
    record.deleted=recovery.id;await this.commit(game,data,`移除 ${clean(path.basename(directory))}`,[{kind:'swap',target:directory}]);return this.scan(game);
  }
  async updateInstallPlan(game:GameId,file:string,root:string,binding:GameBananaDownload,target:ModUpdateTarget):Promise<ModDownloadInstallPlan>{
    const {data,record,directory}=await this.context(game,target.modId);if(data.root.toLowerCase()!==root.toLowerCase()||record!.contentRevision!==target.contentRevision)throw new Error('更新目标或内容已改变，请重新检查；下载包保留。');
    const work=await this.unpackDownload(game,file,root,binding);
    const inis=async(folder:string)=>{const values=new Map<string,string>();let total=0;const walk=async(current:string,depth:number)=>{if(depth>16)throw new Error('更新配置目录过深。');await assertNoLinks(current);for(const entry of await fs.readdir(current,{withFileTypes:true})){const input=path.join(current,entry.name);if(entry.isSymbolicLink())throw new Error('配置预览不允许链接。');if(entry.isDirectory())await walk(input,depth+1);else if(entry.isFile()&&modIni(entry.name)){const stat=await fs.stat(input);if(stat.size>4*1024**2||(total+=stat.size)>64*1024**2||values.size>=2048)throw new Error('配置差异预览超过 4 MiB/64 MiB 或 2048 文件限制。');values.set(path.relative(folder,input).replaceAll('\\','/'),createHash('sha256').update(await fs.readFile(input)).digest('hex'));}}};await walk(folder,0);return values;};
    try{const old=await inis(directory);const items:ModDownloadInstallPlan['items']=[];for(const candidate of work.candidates){const current=await inis(candidate?containedPath(work.unpacked,candidate):work.unpacked);const configChanges=[...new Set([...old.keys(),...current.keys()])].sort().map(relativePath=>({relativePath,kind:(!old.has(relativePath)?'added':!current.has(relativePath)?'removed':old.get(relativePath)===current.get(relativePath)?'same':'changed') as import('../shared/contracts').ModConfigChange['kind']}));items.push({entryPath:candidate.replaceAll('\\','/'),folder:'',name:candidate?clean(path.basename(candidate)):clean(path.basename(binding.remote.fileName,path.extname(binding.remote.fileName))),character:record!.metadata.character,configChanges});}return {targetRoot:root,updateTarget:target,updatePreview:{name:clean(path.basename(directory)),relativePath:record!.relativePath,versionBefore:readProvenance(record!.provenance).version,versionAfter:binding.version,enabled:!record!.relativePath.split(path.sep).some(disabled)&&!disabled(path.basename(root)),activeProfile:!!data.activeProfile?.files.some(f=>f.modId===record!.id)},folders:[''],items};}finally{await fs.rm(work.unpacked,{recursive:true}).catch(()=>{});}
  }
  async installUpdate(game:GameId,file:string,root:string,binding:GameBananaDownload,target:ModUpdateTarget,destinations?:ModInstallDestination[],confirmation?:DependencyConfirmation){
    const plan=await this.updateInstallPlan(game,file,root,binding,target);if(!destinations||destinations.length!==1||!plan.items.some(item=>item.entryPath===destinations[0].entryPath))throw new Error('更新请明确选择压缩包中的一个 Mod 条目。');
    const work=await this.unpackDownload(game,file,root,binding);try{const entry=destinations[0].entryPath;const source=entry?containedPath(work.unpacked,entry):work.unpacked;const library=await this.replace(game,target.modId,source,confirmation,{binding:{...binding,remote:{...binding.remote,entryPath:entry}},target});return {library,importedIds:[target.modId],errors:[],canceled:false,items:[{id:target.modId,name:library.mods.find(m=>m.id===target.modId)!.name,ok:true}]};}finally{await fs.rm(work.unpacked,{recursive:true}).catch(()=>{});}
  }
  async replace(game:GameId,id:string,source:string,confirmation?:DependencyConfirmation,update?:{binding:GameBananaDownload;target:ModUpdateTarget}):Promise<LibrarySnapshot> {
    const snapshot=await this.scan(game);const mod=snapshot.mods.find(m=>m.id===id);if(!mod)throw new Error('Mod 缺失。');if(update&&mod.contentRevision!==update.target.contentRevision)throw new Error('目标 Mod 内容已变化，请重新检查。');
    const nextVersion=update?.binding.version||'';await this.checkedStates(game,{...snapshot,mods:snapshot.mods.map(m=>m.id===id?{...m,provenance:{...m.provenance,version:nextVersion}}:m)},{states:{[id]:mod.enabled}},confirmation);
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id); await assertNoLinks(source);
    const provenance=updateProvenance(record.provenance,{...editableProvenance(readProvenance(record.provenance)),version:nextVersion,gameVersion:'',verification:'unverified',...(update?{sourceUrl:`https://gamebanana.com/mods/${update.binding.remote.modId}`}:{})},'replaced');
    if(relation(directory,source)||relation(source,directory)||relation(data.root,source)) throw new Error('替换来源与已管理目录重叠。');
    const workRoot=path.join(this.dataDirectory,'replacements'); await fs.mkdir(workRoot,{recursive:true}); const work=await fs.mkdtemp(path.join(workRoot,'replace-'));
    try {
    let input=source; const stat=await fs.stat(source); if(stat.isFile()) { input=path.join(work,'unpacked'); await extractModArchive(source,input); }
    if(!await hasIni(input)) throw new Error('替换来源没有 Mod INI。');
    const entries=await fs.readdir(input,{withFileTypes:true}); const direct=entries.some(entry=>entry.isFile()&&modIni(entry.name));
    if(!direct) { const candidates=await discover(input); if(candidates.length!==1) throw new Error('替换压缩包或目录必须只包含一个明确的 Mod。'); input=path.join(input,candidates[0]); }
    const payload=path.join(work,'payload'); await copyDirectory(input,payload);
    // Preserve a chosen cover independently of replacement content and all registry metadata/disabled state.
    if(record.cover && await present(containedPath(directory,record.cover)) && (record.cover.startsWith('.kmm-cover') || !await present(containedPath(payload,record.cover)))) { const oldCover=containedPath(directory,record.cover); const newCover=containedPath(payload,record.cover); await assertNoLinks(oldCover); await assertNoLinks(newCover); await fs.copyFile(oldCover,newCover); }
    const profileContext=update?await this.updateProfiles?.context(game):undefined;
    await new RecoveryStore(this.dataDirectory).create(game,{root:data.root,kind:'mod-replace',name:clean(path.basename(directory)),relativePath:record.relativePath,modId:id,record,profileContext,includesContent:true},target=>copyDirectory(directory,target));
    record.provenance=provenance;record.contentRevision=randomUUID();
    delete record.remote;
    if(update){record.remote={...update.binding.remote};}
    const extras=update?await this.updateProfiles?.rebase(game,data,record,payload)||[]:[];
    await this.operations.run(game,data.root,`替换 ${clean(path.basename(directory))}`,[{kind:'swap',target:directory,source:payload}],[{target:this.file(game),bytes:JSON.stringify(data,null,2)},...extras]);this.snapshots.delete(game);
    return await this.scan(game);
    }finally{await assertNoLinks(work);await fs.rm(work,{recursive:true});}
  }
  async cover(game:GameId,id:string):Promise<string|null> {
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id); if(!record.cover) return null;
    const target=containedPath(directory,record.cover); await assertNoLinks(target); const stat=await fs.stat(target); if(stat.size>10*1024**2) throw new Error('预览图超过10MB。');
    const ext=path.extname(target).toLowerCase(); const type:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
    if(!type[ext]) throw new Error('预览仅支持PNG、JPEG、WebP、GIF。'); return `data:${type[ext]};base64,${(await this.images.read(target)).toString('base64')}`;
  }
  async setCover(game:GameId,id:string,source:string):Promise<LibrarySnapshot> {
    const data=await this.load(game); const {record,directory}=await this.resolve(data,id); const ext=path.extname(source).toLowerCase(); if(!['.png','.jpg','.jpeg','.webp','.gif'].includes(ext)) throw new Error('请选择支持的本地图片。');
    await assertNoLinks(source); if((await fs.stat(source)).size>10*1024**2) throw new Error('预览图超过10MB。'); const name='.kmm-cover'+ext; const target=path.join(directory,name); await assertNoLinks(target); if(source.toLowerCase()!==target.toLowerCase()) await writeAtomicFile(target,await fs.readFile(source)); record.cover=name; await this.save(game,data); return this.scan(game);
  }
  async addGroup(game:GameId,kind:'category'|'character'|'appearance',name:string):Promise<LibrarySnapshot> {
    const data=await this.load(game); if(!['category','character','appearance'].includes(kind)) throw new Error('分类类型无效。'); const label=safeName(name); if(!data.groups[kind].includes(label)) data.groups[kind].push(label); await this.save(game,data); return this.scan(game);
  }
}
