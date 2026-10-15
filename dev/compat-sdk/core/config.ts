import path from 'node:path';
import {readJson} from './files';
import type {Config, GameConfig} from './types';

export function parseConfig(value: unknown): Config {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('SDK 配置必须为对象');
    return v as Record<string, unknown>;
  };
  const record = object(value);
  const keys = (v: Record<string, unknown>, allowed: string[]) => {
    if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('SDK 配置包含未知字段');
  };
  const text = (v: unknown, name: string) => {
    if (typeof v !== 'string' || !v.trim() || v.length > 4096 || /[\x00-\x1f]/.test(v)) throw new Error(`无效配置字段 ${name}`);
    return v.trim();
  };
  const absolute = (v: unknown, name: string) => {
    const s = text(v, name);
    if (!path.isAbsolute(s) || path.resolve(s) === path.parse(path.resolve(s)).root) throw new Error(`${name} 必须为具体绝对路径`);
    return path.resolve(s);
  };
  const number = (v: unknown, fallback: number, min: number) => {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > 3600000) throw new Error('无效轮询/稳定观察间隔');
    return v;
  };
  keys(record, ['schemaVersion', 'machineProfile', 'games', 'stableDelayMs', 'pollMs']);
  if (record.schemaVersion !== 1) throw new Error('SDK 配置 schemaVersion 必须为 1');
  const games = object(record.games);
  keys(games, ['zzz', 'endfield']);
  if (!Object.keys(games).length) throw new Error('至少配置一款游戏');
  const result: Config = {schemaVersion: 1, machineProfile: text(record.machineProfile, 'machineProfile'), games: {}, stableDelayMs: number(record.stableDelayMs, 2000, 100), pollMs: number(record.pollMs, 60000, 1000)};
  for (const game of ['zzz', 'endfield'] as const) {
    if (games[game] === undefined) continue;
    const g = object(games[game]);
    keys(g, ['gameRoot', 'xxmiRoot', 'channel', 'fixtureRoot', 'sceneFile']);
    const config: GameConfig = {gameRoot: absolute(g.gameRoot, 'gameRoot'), channel: text(g.channel, 'channel')};
    for (const k of ['xxmiRoot', 'fixtureRoot', 'sceneFile'] as const) if (g[k] !== undefined) config[k] = absolute(g[k], k);
    result.games[game] = config;
  }
  return result;
}
export async function loadConfig(file: string) { return parseConfig(await readJson(file)); }
