import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { path7z } from '7zip-bin-full';
import { extractZip, containedPath, assertNoLinks } from './archive';
export async function extractModArchive(source: string, destination: string): Promise<void> {
  const extension = path.extname(source).toLowerCase();
  if (extension === '.zip') { await extractZip(source, destination); return; }
  if (!['.7z', '.rar'].includes(extension)) throw new Error('请选择 ZIP、7z 或 RAR 压缩包。');
  await assertNoLinks(destination); await fs.mkdir(destination, { recursive: true });
  const execute = promisify(execFile);
  // A technical listing lets us reject unsafe paths/links before 7-Zip writes any entry.
  let listing: string;
  try { listing = (await execute(path7z, ['l', '-slt', '-ba', '-sccUTF-8', '-p-', '--', source], { windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 ** 2 })).stdout; }
  catch { throw new Error('压缩包无法读取，可能损坏或需要密码。'); }
  let count = 0; let bytes = 0;
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const name = /^Path = (.+)$/m.exec(block)?.[1]?.replace(/\r$/, ''); if (!name) continue;
    containedPath(destination, name); count++;
    if (/^(Symbolic Link|Hard Link) = /m.test(block) || /^Attributes = .*\bl[rwx-]{9}/m.test(block)) throw new Error('压缩包含链接，不能导入。');
    bytes += Number(/^Size = (\d+)/m.exec(block)?.[1] || 0);
  }
  if (!count || count > 50000 || bytes > 2 * 1024 ** 3) throw new Error('压缩包为空或超出解压数量 / 大小限制。');
  try { await execute(path7z, ['x', '-y', '-p-', '-sccUTF-8', `-o${destination}`, '--', source], { windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 ** 2 }); }
  catch { throw new Error('解包失败，请检查压缩包、密码与磁盘空间。'); }
  const check = async (directory: string) => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); await assertNoLinks(file); if (entry.isDirectory()) await check(file); } };
  await check(destination);
}
