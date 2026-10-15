import {createHash, randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {assertNoLinks} from '../../../src/main/archive';
import {isInside, sha} from '../../../src/main/inspection-files';
import type {FileEvidence} from './types';

export {sha};
export const REPO = path.resolve(__dirname, '../../..');
export const OUTPUT = path.join(REPO, '.run-data', 'compat-sdk');
export const identity = (stat: {dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint}) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

export async function hashFile(file: string, limit = 512 * 1024 ** 2, signal?: AbortSignal): Promise<FileEvidence> {
  await assertNoLinks(file);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat({bigint: true});
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error('文件类型或摘要预算不符');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      signal?.throwIfAborted();
      const {bytesRead} = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      if (position > limit) throw new Error('文件增长超过摘要预算');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({bigint: true});
    const current = await fs.stat(file, {bigint: true});
    if (identity(before) !== identity(after) || identity(after) !== identity(current)) throw new Error('摘要期间文件发生变化');
    return {path: path.resolve(file), digest: hash.digest('hex'), bytes: position, identity: identity(after)};
  } finally { await handle.close(); }
}

export async function treeHashes(root: string, limit = 256 * 1024 ** 2): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const queue = [root];
  let bytes = 0, nodes = 0;
  while (queue.length) {
    const file = queue.shift()!;
    if (++nodes > 10000) throw new Error('目录超过 SDK 摘要节点预算');
    await assertNoLinks(file);
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(file)).sort()) queue.push(path.join(file, name));
    } else {
      bytes += stat.size;
      if (!stat.isFile() || bytes > limit) throw new Error('目录超过 SDK 摘要预算');
      files[path.relative(root, file).replaceAll('\\', '/')] = (await hashFile(file, limit)).digest;
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export async function sourceHashes(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const folder of ['src', 'dev/compat-sdk', 'tests', 'scripts']) {
    const hashes = await treeHashes(path.join(REPO, folder));
    for (const [file, digest] of Object.entries(hashes)) result[`${folder}/${file}`] = digest;
  }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.main.json', 'vite.config.ts']) {
    result[file] = (await hashFile(path.join(REPO, file))).digest;
  }
  return result;
}

export async function readJson(file: string): Promise<unknown> {
  await assertNoLinks(file);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 16 * 1024 ** 2) throw new Error('JSON 超出读取预算');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function outputPath(...parts: string[]) {
  const file = path.resolve(OUTPUT, ...parts);
  if (!isInside(OUTPUT, file) || file === OUTPUT) throw new Error('输出路径必须位于 SDK 工作区内部');
  return file;
}

export async function saveJson(file: string, value: unknown, exclusive = false) {
  if (!isInside(OUTPUT, file) || file === OUTPUT) throw new Error('禁止写入 SDK 工作区以外');
  await assertNoLinks(file);
  await fs.mkdir(path.dirname(file), {recursive: true});
  if (exclusive) return fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
  const tmp = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, {force: true}); }
}

export async function withLock<T>(name: string, work: () => Promise<T>): Promise<T> {
  const file = outputPath('locks', name + '.json');
  await saveJson(file, {pid: process.pid, startedAt: new Date().toISOString()}, true);
  try { return await work(); } finally { await fs.unlink(file); }
}
