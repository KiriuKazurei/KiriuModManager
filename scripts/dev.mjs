import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import electron from 'electron';
import path from 'node:path';
const root = process.cwd();
const compile = spawn(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.main.json'], { stdio: 'inherit' });
const status = await new Promise(resolve => compile.on('exit', resolve));
if (status !== 0) process.exit(Number(status) || 1);
const server = await createServer({ server: { host: '127.0.0.1', port: 5173, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const env = { ...process.env, KMM_DEV_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { env, stdio: 'inherit', windowsHide: false });
console.log(`React development server: ${url}`);
console.log('Electron main/preload changes require restarting npm run dev.');
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill();
  await server.close();
  process.exit(code);
}
child.on('error', error => { console.error(error.message); void stop(1); });
child.on('exit', code => void stop(code || 0));
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
