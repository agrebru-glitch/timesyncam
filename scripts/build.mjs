// Сборка: интерфейс через Vite, main и preload через esbuild.
import { build as viteBuild } from 'vite';
import { build as esbuild } from 'esbuild';

export async function buildElectron() {
  const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: true, logLevel: 'warning' };
  await esbuild({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.cjs' });
  await esbuild({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.cjs' });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('build.mjs')) {
  await viteBuild({ configFile: 'vite.config.mts', logLevel: 'warn' });
  await buildElectron();
  console.log('Сборка готова: dist/');
}
