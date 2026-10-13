import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as yauzl from 'yauzl';

export function containedPath(root: string, relative: string): string {
  const name = relative.replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(part => part === '..' || part.includes(':')) || name.includes('\0')) throw new Error('压缩包包含不安全的目录路径。');
  const destination = path.resolve(root, name);
  const relation = path.relative(path.resolve(root), destination);
  if (relation.startsWith('..') || path.isAbsolute(relation)) throw new Error('压缩包路径越出了目标目录。');
  return destination;
}
export async function assertNoLinks(target: string): Promise<void> {
  let current = path.resolve(target);
  while (true) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('目标路径包含符号链接或目录联接，请选择普通目录。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) return; current = parent;
  }
}
export async function extractZip(archive: string, destination: string): Promise<number> {
  await assertNoLinks(destination);
  await fs.mkdir(destination, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file!)));
  let files = 0; let total = 0; const seen = new Set<string>();
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (error: Error) => { if (!failed) { failed = true; zip.close(); reject(error); } };
    zip.on('error', fail);
    zip.on('end', () => { if (!failed) resolve(files); });
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode === 0xa000 || (mode && mode !== 0x8000 && mode !== 0x4000)) throw new Error('压缩包包含链接或特殊文件，已停止解包。');
        const target = containedPath(destination, entry.fileName);
        const identity = target.toLowerCase();
        if (seen.has(identity)) throw new Error('压缩包包含重复目标路径。'); seen.add(identity);
        total += entry.uncompressedSize;
        if (total > 2 * 1024 ** 3 || ++files > 50000) throw new Error('压缩包超出允许的文件数量或解压大小。');
        await assertNoLinks(target);
        if (entry.fileName.endsWith('/')) await fs.mkdir(target, { recursive: true });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (error, input) => error ? rej(error) : res(input!)));
          await pipeline(stream, createWriteStream(target, { flags: 'wx' }));
        }
        if (!failed) zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}
