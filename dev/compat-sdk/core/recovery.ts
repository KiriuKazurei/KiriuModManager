import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertNoLinks, containedPath} from '../../../src/main/archive';
import {fileBytes} from '../../../src/main/inspection-files';
import {writeAtomicFile} from '../../../src/main/atomic-json';
import {OUTPUT, outputPath, readJson, saveJson, sha} from './files';

interface Entry {relative: string; before: string | null; afterDigest: string; restored: boolean}
interface Journal {schemaVersion: 1; owner: string; entries: Entry[]}

// All writes are restricted to a newly created SDK sandbox. Real installations are never write roots.
export class RecoveryJournal {
  private constructor(readonly root: string, private state: Journal) {}
  static async create(runDirectory: string) {
    const root = outputPath(path.relative(OUTPUT, runDirectory), 'sandbox');
    await assertNoLinks(root);
    await fs.mkdir(path.dirname(root), {recursive: true});
    await fs.mkdir(root); // Exclusive ownership: an existing directory cannot be adopted.
    const journal = new RecoveryJournal(root, {schemaVersion: 1, owner: randomUUID(), entries: []});
    await saveJson(path.join(root, 'owner.json'), {owner: journal.state.owner}, true);
    await journal.persist();
    return journal;
  }
  static async open(root: string) {
    const target = outputPath(path.relative(OUTPUT, root));
    const raw = await readJson(path.join(target, 'journal.json')) as Journal;
    const marker = await readJson(path.join(target, 'owner.json')) as {owner: string};
    if (raw.schemaVersion !== 1 || typeof raw.owner !== 'string' || raw.owner !== marker.owner || !Array.isArray(raw.entries) || raw.entries.length > 1000) throw new Error('恢复日志所有权/格式无效');
    const seen = new Set<string>();
    for (const e of raw.entries) {
      if (typeof e.relative !== 'string' || typeof e.restored !== 'boolean' || !/^[a-f0-9]{64}$/.test(e.afterDigest) || e.before !== null && (typeof e.before !== 'string' || e.before.length > 2 * 1024 ** 2)) throw new Error('恢复条目无效');
      const file = containedPath(path.join(target, 'work'), e.relative);
      if (seen.has(file.toLowerCase())) throw new Error('重复恢复目标');
      seen.add(file.toLowerCase());
    }
    return new RecoveryJournal(target, raw);
  }
  private persist() { return saveJson(path.join(this.root, 'journal.json'), this.state); }
  async write(relative: string, bytes: Buffer) {
    if (bytes.length > 1024 ** 2) throw new Error('SDK 恢复写入超过预算');
    const file = containedPath(path.join(this.root, 'work'), relative);
    if (this.state.entries.some(e => containedPath(path.join(this.root, 'work'), e.relative).toLowerCase() === file.toLowerCase())) throw new Error('同一恢复目标本轮只能写一次');
    await assertNoLinks(file);
    let before: Buffer | null = null;
    try { before = await fileBytes(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const entry: Entry = {relative, before: before?.toString('base64') ?? null, afterDigest: sha(bytes), restored: false};
    this.state.entries.push(entry);
    await this.persist(); // WAL before the mutation, including the expected post-write digest.
    await writeAtomicFile(file, bytes, before ? sha(before) : 'missing');
  }
  async restore(): Promise<{complete: boolean; conflicts: string[]}> {
    const conflicts: string[] = [];
    for (const e of [...this.state.entries].reverse()) {
      if (e.restored) continue;
      const file = containedPath(path.join(this.root, 'work'), e.relative);
      try {
        let current: Buffer | null = null;
        try { current = await fileBytes(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        const original = e.before === null ? null : Buffer.from(e.before, 'base64');
        const digest = current ? sha(current) : 'missing';
        if (digest !== (original ? sha(original) : 'missing')) {
          if (digest !== e.afterDigest) throw new Error('目标被外部修改，保留新值和恢复副本');
          if (original) await writeAtomicFile(file, original, e.afterDigest);
          else {
            await assertNoLinks(file);
            if (sha(await fileBytes(file)) !== e.afterDigest) throw new Error('恢复前目标发生变化');
            await fs.unlink(file);
          }
        }
        e.restored = true;
        await this.persist();
      } catch (error) { conflicts.push(`${e.relative}: ${(error as Error).message}`); }
    }
    return {complete: conflicts.length === 0, conflicts};
  }
}

export async function pendingRecovery(): Promise<string[]> {
  const result: string[] = [];
  for (const game of ['zzz', 'endfield']) {
    const root = outputPath(game);
    let entries;
    try { entries = await fs.readdir(root, {withFileTypes: true}); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (entries.length > 10000) throw new Error('恢复检查超过记录预算');
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const sandbox = path.join(root, entry.name, 'sandbox');
      try {
        const journal = await readJson(path.join(sandbox, 'journal.json')) as Journal;
        if (!Array.isArray(journal.entries) || journal.entries.some(e => !e.restored)) result.push(sandbox);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.push(sandbox); }
    }
  }
  return result;
}
