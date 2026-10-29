// Режим разработки: Vite с горячей перезагрузкой интерфейса + Electron.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electronPath from 'electron';
import { buildElectron } from './build.mjs';

const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
const url = server.resolvedUrls.local[0];
await buildElectron();

const child = spawn(electronPath, ['.'], { stdio: 'inherit', env: { ...process.env, SYNC_DEV_URL: url } });
child.on('close', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
