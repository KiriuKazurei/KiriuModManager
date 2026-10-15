import {setTimeout as delay} from 'node:timers/promises';
import type {GameId} from '../../../src/shared/contracts';
import {stableContext} from '../adapters/context';
import {OUTPUT, outputPath, readJson, saveJson, sha, withLock} from './files';
import {createFixTask} from './tasks';
import type {Config, Context} from './types';
import type {Runner} from './runner';
import path from 'node:path';

interface WatchEntry {runKey: string; observationKey: string; verdict: string; reportFile: string; waitingObservation?: string; lastCompatible?: {runKey: string; reportFile: string}}
export async function watch(config: Config, runner: Runner, options: {signal?: AbortSignal; once?: boolean; onResult?: (result: unknown) => void; probe?: typeof stableContext} = {}) {
  return withLock('watch', async () => {
    let state: Partial<Record<GameId, WatchEntry>> = {};
    const stateFile = outputPath('watch-state-' + sha(config.machineProfile).slice(0, 16) + '.json');
    try { state = await readJson(stateFile) as typeof state; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    let count = 0, exitCode = 0;
    do {
      exitCode = 0;
      for (const game of ['zzz', 'endfield'] as const) {
        if (!config.games[game] || options.signal?.aborted) continue;
        let context: Context;
        try { context = await (options.probe ?? stableContext)(config, game, options.signal); }
        catch (error) { if (options.signal?.aborted) break; exitCode = 2; options.onResult?.({game, verdict: 'inconclusive', message: (error as Error).message}); continue; }
        const previous = state[game];
        if (context.stability !== 'stable') {
          exitCode = 2;
          const waitingObservation = context.stability + ':' + context.observationKey;
          if (previous?.waitingObservation !== waitingObservation) {
            state[game] = {...previous ?? {runKey: '', observationKey: '', verdict: 'inconclusive', reportFile: ''}, waitingObservation};
            await saveJson(stateFile, state);
            options.onResult?.({game, verdict: 'inconclusive', stability: context.stability, issues: context.issues});
          }
          continue; // Preserve the previous stable build while updating.
        }
        if (previous?.runKey === context.runKey && (previous.verdict === 'compatible' || previous.observationKey === context.observationKey)) {
          exitCode = Math.max(exitCode, previous.verdict === 'compatible' ? 0 : previous.verdict === 'incompatible' ? 1 : 2);
          continue;
        }
        const {report, directory} = await runner.run(config, game, 'full', {signal: options.signal, probe: options.probe});
        if (report.context.runKey !== context.runKey || report.context.observationKey !== context.observationKey || report.endRunKey !== context.runKey) {exitCode = 2; continue;}
        const reportFile = path.join(directory, 'report.json');
        state[game] = {runKey: context.runKey, observationKey: context.observationKey, verdict: report.verdict, reportFile, lastCompatible: report.verdict === 'compatible' ? {runKey: context.runKey, reportFile} : previous?.lastCompatible};
        await saveJson(stateFile, state);
        count++;
        exitCode = Math.max(exitCode, report.exitCode);
        if (report.verdict === 'incompatible') await createFixTask(reportFile);
        if (report.verdict !== 'compatible') options.onResult?.({game, verdict: report.verdict, report: path.relative(OUTPUT, reportFile)});
      }
      if (options.once || options.signal?.aborted) break;
      try { await delay(config.pollMs, undefined, {signal: options.signal}); } catch { break; }
    } while (!options.signal?.aborted);
    return {runs: count, exitCode: options.signal?.aborted ? 2 : exitCode};
  });
}
