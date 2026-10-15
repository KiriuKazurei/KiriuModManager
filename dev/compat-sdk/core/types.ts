import type {GameId} from '../../../src/shared/contracts';

export const SDK_VERSION = '0.2.0';
export const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type Layer = typeof LAYERS[number];
export type Verdict = 'compatible' | 'incompatible' | 'inconclusive';
export type Attribution = 'manager' | 'component' | 'fixture' | 'environment' | 'test';
export interface GameConfig {
  gameRoot: string;
  xxmiRoot?: string;
  channel: string;
  fixtureRoot?: string;
  sceneFile?: string;
}
export interface Config {
  schemaVersion: 1;
  machineProfile: string;
  games: Partial<Record<GameId, GameConfig>>;
  stableDelayMs: number;
  pollMs: number;
}
export interface FileEvidence {path: string; digest: string; bytes: number; identity: string}
export interface Context {
  schemaVersion: 1;
  sdkVersion: string;
  gameId: GameId;
  channel: string;
  observedAt: string;
  stability: 'stable' | 'unknown' | 'updating';
  source: {commit: string; digest: string};
  machine: {profile: string; platform: string; arch: string; release: string; node: string};
  game: {root: string; executable?: string; releaseVersion: null; buildKey: string; files: FileEvidence[]; pe: {fileVersion: string; productVersion: string} | null; coverage: string[]};
  xxmi: {root?: string; importerDirectory?: string; launcherPath?: string; launchPlan?: {executable: string; args: string[]; cwd: string}; installed: boolean; gameDirectory?: string; modsDirectories: string[]; versions: Record<string, string | null>; files: FileEvidence[]; rulesConfirmed: boolean};
  fixtures: {revision: string; sceneRevision: string};
  observationKey: string;
  runKey: string;
  issues: string[];
}
export interface Attempt {
  status: 'passed' | 'failed' | 'inconclusive' | 'skipped';
  message: string;
  attribution?: Attribution;
  controlPassed?: boolean;
  evidence?: string[];
}
export interface CaseResult {id: string; layer: Layer; required: boolean; attempts: Attempt[]}
export interface RunReport {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  context: Context;
  endRunKey: string;
  scope: 'local' | 'full';
  results: CaseResult[];
  recovery: 'complete' | 'blocked';
  selectedVerdict: Verdict;
  verdict: Verdict;
  exitCode: 0 | 1 | 2;
}
export interface TestCase {
  id: string;
  layer: Layer;
  required: boolean;
  timeoutMs: number;
  run(context: Context, signal: AbortSignal, tools: {directory: string}): Promise<Attempt>;
}
