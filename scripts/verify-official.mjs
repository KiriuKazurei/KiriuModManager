import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { DeploymentService } = require('../dist/main/deployment.js');
const { checkRuntime } = require('../dist/main/runtime.js');
const parent = path.resolve(process.env.KMM_OFFICIAL_DIR || '.run-data/official-deployment');
await fs.mkdir(parent, { recursive: true });
const run = await fs.mkdtemp(path.join(parent, 'run-'));
const reports = [];
for (const gameId of ['zzz', 'endfield']) {
  const root = path.join(run, gameId); const gameDirectory = path.join(root, 'Game fixture');
  await fs.mkdir(gameDirectory, { recursive: true });
  await fs.writeFile(path.join(gameDirectory, gameId === 'zzz' ? 'ZenlessZoneZero.exe' : 'Endfield.exe'), 'Verification placeholder only; never execute.');
  const paths = { xxmiRoot: path.join(root, 'XXMI'), gameDirectory, modsDirectory: path.join(root, 'Custom Mods') };
  const service = new DeploymentService({ fetch: globalThis.fetch, cacheDirectory: path.join(root, 'downloads'), checkRuntime });
  const ticker = setInterval(() => console.log(gameId, service.progress.stage, service.progress.percent + '%', service.progress.message), 5000);
  try {
    const result = await service.deploy(gameId, paths);
    reports.push({ gameId, officialAssets: true, fixtureGameExecutable: true, gameLaunchVerified: false, ...result });
    await fs.writeFile(path.join(root, 'report.json'), JSON.stringify(reports.at(-1), null, 2));
    console.log(gameId, 'official signed payload deployment PASS', JSON.stringify(result.versions));
  } finally { clearInterval(ticker); }
}
await fs.writeFile(path.join(run, 'report.json'), JSON.stringify({ result: 'PASS', run, reports }, null, 2));
console.log('Official evidence:', run);
