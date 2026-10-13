import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { DeploymentProgress, DeploymentResult, GameId, GamePaths, GAMES, RuntimeStatus } from '../shared/contracts';
import { assertNoLinks, containedPath, extractZip } from './archive';
import { downloadAsset, downloadManifest, FetchClient, OFFICIAL_SOURCES, PackageSource, ReleaseAsset, resolveRelease, sourcesForGame, verifySignature } from './releases';
import { syncXXMIPaths, validatePaths } from './sync';
import { createHash } from 'node:crypto';

interface Manifest { version: string; signatures: Record<string, string> }
export interface DeploymentDependencies {
  fetch: FetchClient;
  cacheDirectory: string;
  checkRuntime: () => Promise<RuntimeStatus>;
  sources?: (game: GameId) => PackageSource[]; // Imported only by fixtures; renderer never supplies sources or clients.
}
async function requireFile(file: string) {
  if (!(await fs.stat(file)).isFile()) throw new Error(`发行包缺少必要文件：${path.basename(file)}`);
}
async function ensureEmpty(root: string) {
  await assertNoLinks(root);
  try { if ((await fs.readdir(root)).length) throw new Error('安装位置已有内容。请使用空目录部署；已有 XXMI 请通过检测与路径同步接入。'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function inventory(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('部署目录包含链接。');
      if (entry.isDirectory()) { files.push(path.relative(root, current) + path.sep); await walk(current); }
      else if (entry.isFile()) files.push(path.relative(root, current));
      else throw new Error('部署目录包含特殊文件。');
    }
  }
  await walk(root); return files;
}
async function copyIntoEmpty(source: string, destination: string) {
  await ensureEmpty(destination); await fs.mkdir(destination, { recursive: true });
  const files = await inventory(source);
  for (const name of files) {
    const target = containedPath(destination, name); await assertNoLinks(target);
    if (name.endsWith(path.sep)) { await fs.mkdir(target, { recursive: true }); continue; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, name), target, constants.COPYFILE_EXCL);
    const expected = createHash('sha256').update(await fs.readFile(path.join(source, name))).digest('hex');
    const actual = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    if (actual !== expected) throw new Error(`部署文件校验失败：${name}，请检查权限或杀毒软件隔离。`);
  }
}
export async function runPostInstall(importerDirectory: string) {
  const commandsPath = path.join(importerDirectory, 'Core', 'auto_update.xcmd');
  let commands: string;
  try { commands = await fs.readFile(commandsPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  let section = '';
  for (const raw of commands.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || /^[;#]/.test(line)) continue;
    const heading = /^\[(.*?)\]/.exec(line); if (heading) { section = heading[1].toLowerCase(); continue; }
    if (section !== 'preinstall' && section !== 'postinstall') continue;
    const command = /^delete\s*=\s*(.*?)\s*(?:;.*)?$/i.exec(line);
    if (!command) throw new Error('官方安装迁移包含不受支持的命令，已停止部署。');
    const name = command[1].replace(/\\/g, '/'); const parts = name.split('/');
    if (!['core', 'shaderfixes'].includes(parts[0].toLowerCase()) || parts.length < 2 || parts.some(part => !part || part === '.' || part === '..' || /[*?]/.test(part))) throw new Error('官方安装迁移超出允许的 Core / ShaderFixes 范围。');
    const target = containedPath(importerDirectory, name); await assertNoLinks(target);
    // A new installation has no previous files. PreInstall deletes are intentionally no-ops.
    if (section === 'postinstall') await fs.rm(target, { recursive: true, force: true });
  }
}
export class DeploymentService {
  progress: DeploymentProgress = { stage: 'idle', message: '尚未开始部署。', percent: 0 };
  private running = false;
  constructor(private readonly dependencies: DeploymentDependencies) {}
  private update(stage: DeploymentProgress['stage'], message: string, percent: number, bytes?: number, totalBytes?: number) { this.progress = { stage, message, percent, bytes, totalBytes }; }
  async deploy(gameId: GameId, input: GamePaths): Promise<Omit<DeploymentResult, 'settings'>> {
    if (this.running) throw new Error('已有部署正在进行，请等待完成。');
    this.running = true;
    let destinationTouched = false;
    try {
      const fields = await validatePaths(gameId, input); await ensureEmpty(fields.xxmiRoot);
      this.update('resolve', '正在读取官方稳定发行信息…', 2);
      const sources = (this.dependencies.sources || sourcesForGame)(gameId);
      const assets: ReleaseAsset[] = [];
      for (const source of sources) assets.push(await resolveRelease(this.dependencies.fetch, source));
      const libs = assets.find(asset => asset.source.id === 'XXMI');
      if (!libs) throw new Error('缺少官方 XXMI 共享组件。');
      await assertNoLinks(this.dependencies.cacheDirectory); await fs.mkdir(this.dependencies.cacheDirectory, { recursive: true });
      const work = await fs.mkdtemp(path.join(this.dependencies.cacheDirectory, 'deploy-'));
      const staging = path.join(work, 'payload'); await fs.mkdir(staging);
      const versions: Record<string, string> = {};
      let libManifest: Manifest | null = null;
      for (let index = 0; index < assets.length; index++) {
        const asset = assets[index]; const archive = path.join(work, asset.name);
        const basePercent = 5 + index * 24;
        this.update('download', `正在下载 ${asset.source.id} ${asset.version}…`, basePercent);
        await downloadAsset(this.dependencies.fetch, asset, archive, (bytes, total) => this.update('download', `正在下载 ${asset.source.id} ${asset.version}…`, Math.round(basePercent + bytes / total * 18), bytes, total));
        this.update('verify', `${asset.source.id} 官方签名已验证。`, basePercent + 19);
        const packageDirectory = path.join(staging, 'Resources', 'Packages', asset.source.id);
        const target = asset.source.id === 'Launcher' ? staging : asset.source.id === 'XXMI' ? packageDirectory : path.join(staging, asset.source.id);
        this.update('extract', `正在解包 ${asset.source.id}…`, basePercent + 20);
        await extractZip(archive, target);
        await fs.mkdir(packageDirectory, { recursive: true });
        let manifestData = await downloadManifest(this.dependencies.fetch, asset);
        if (!manifestData) {
          try { manifestData = await fs.readFile(path.join(target, 'Manifest.json')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (!manifestData) manifestData = Buffer.from(JSON.stringify({ version: asset.version, signatures: { [asset.name]: asset.signature } }, null, 2));
        let manifest: Manifest;
        try { manifest = JSON.parse(manifestData.toString('utf8')); }
        catch { throw new Error(`${asset.source.id} Manifest 格式无效。`); }
        if (manifest.version !== asset.version || !manifest.signatures || typeof manifest.signatures !== 'object') throw new Error(`${asset.source.id} Manifest 与发行版本不匹配。`);
        await fs.writeFile(path.join(packageDirectory, 'Manifest.json'), manifestData);
        if (asset.source.id === 'XXMI') {
          for (const name of ['3dmloader.dll', 'd3d11.dll', 'd3dcompiler_47.dll']) {
            const data = await fs.readFile(path.join(packageDirectory, name));
            if (!verifySignature(data, manifest.signatures[name], asset.source.publicKey)) throw new Error(`共享库 ${name} 官方签名校验失败。`);
          }
          libManifest = manifest;
        }
        versions[asset.source.id] = asset.version;
      }
      if (!libManifest) throw new Error('XXMI 共享组件验证未完成。');
      const name = GAMES[gameId].importer; const importer = path.join(staging, name);
      await requireFile(path.join(staging, 'Resources', 'Bin', 'XXMI Launcher.exe'));
      await requireFile(path.join(importer, 'd3dx.ini')); await requireFile(path.join(importer, 'Core', name, 'main.ini'));
      await runPostInstall(importer);
      for (const file of ['d3d11.dll', 'd3dcompiler_47.dll']) await fs.copyFile(path.join(staging, 'Resources', 'Packages', 'XXMI', file), path.join(importer, file), constants.COPYFILE_EXCL);
      this.update('configure', '正在部署已验证的文件并同步所选游戏路径…', 82);
      destinationTouched = true;
      await copyIntoEmpty(staging, fields.xxmiRoot);
      const synchronized = await syncXXMIPaths(gameId, fields, { 'd3d11.dll': libManifest.signatures['d3d11.dll'], 'd3dcompiler_47.dll': libManifest.signatures['d3dcompiler_47.dll'] });
      const runtime = await this.dependencies.checkRuntime();
      this.update('complete', runtime.installed ? '官方组件与路径部署完成，运行库已检测。' : '官方组件与路径部署完成；仍需安装或确认 Visual C++ x64 运行库。', 100);
      return { inspection: synchronized.inspection, versions, runtime, filesDeployed: true, ready: runtime.installed, backupDirectory: synchronized.backupDirectory };
    } catch (error) {
      const suffix = destinationTouched ? ' 目标可能保留部分部署文件，请检查后改选空目录重试。' : ' 未报告安装成功。';
      const message = `${(error as Error).message}${suffix}`;
      this.update('error', message, this.progress.percent); throw new Error(message);
    } finally { this.running = false; }
  }
}
