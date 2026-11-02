// Сборка TCoder — Android-приложения с экраном синхронизации (mobile/tcoder, подробности — mobile/tcoder/README.md).
// Без Gradle: страница собирается esbuild, приложение — инструментами Android SDK (aapt2, javac, d8, apksigner).
//   node scripts/build-tcoder.mjs → release/TCoder-<версия>.apk
// Нужны: Android SDK (ANDROID_HOME или %LOCALAPPDATA%\Android\Sdk) с build-tools и platforms/android-34,
// JDK (JAVA_HOME или Java из Android Studio), ffmpeg в PATH — для значков.
// Подпись — ключом из TCODER_KEYSTORE (пароль TCODER_KEYSTORE_PASS, псевдоним TCODER_KEY_ALIAS), иначе отладочным.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const app = join(root, 'mobile', 'tcoder');
const out = join(app, '.build');
const win = process.platform === 'win32';
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'Library'), 'Android', win ? 'Sdk' : 'sdk');
const newest = async (dir) => (await readdir(dir)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).pop();
const tools = join(sdk, 'build-tools', await newest(join(sdk, 'build-tools')));
const androidJar = join(sdk, 'platforms', 'android-34', 'android.jar');
const jdk = process.env.JAVA_HOME ?? (win ? 'C:\\Program Files\\Android\\Android Studio\\jbr' : '/Applications/Android Studio.app/Contents/jbr/Contents/Home');
const tool = (name) => join(tools, win ? (/^(d8|apksigner)$/.test(name) ? `${name}.bat` : `${name}.exe`) : name);
const java = (name) => join(jdk, 'bin', win ? `${name}.exe` : name);
// Скриптам SDK (d8, apksigner) нужна Java — та же, что для javac.
const env = { ...process.env, JAVA_HOME: jdk, PATH: `${join(jdk, 'bin')}${win ? ';' : ':'}${process.env.PATH}` };
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], shell: win && cmd.endsWith('.bat'), env, ...opts });
if (!existsSync(androidJar)) throw new Error(`Нет ${androidJar}: поставьте Android SDK Platform 34`);

await rm(out, { recursive: true, force: true });
for (const d of ['assets', 'classes', 'dex']) await mkdir(join(out, d), { recursive: true });

// 1. Страница: экран синхронизации и «О программе». Значок — тот же, что у TimesynCam.
await build({
  entryPoints: [join(app, 'web', 'app.ts')],
  outfile: join(out, 'assets', 'app.js'),
  bundle: true, format: 'iife', target: 'chrome80', minify: true, logLevel: 'warning',
  define: { __APP_VERSION__: JSON.stringify(version) },
});
const icon = (await readFile(join(root, 'build', 'icon.svg'), 'utf8')).replace(/<\?xml[^>]*\?>/, '');
await writeFile(join(out, 'assets', 'index.html'), (await readFile(join(app, 'web', 'index.html'), 'utf8')).replace('<!--ICON-->', icon));
await copyFile(join(app, 'web', 'style.css'), join(out, 'assets', 'style.css'));

// 2. Значок приложения — из build/icon.png под все плотности экрана.
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, px] of Object.entries(densities)) {
  const dir = join(out, 'res', `mipmap-${d}`);
  await mkdir(dir, { recursive: true });
  run('ffmpeg', ['-v', 'error', '-y', '-i', join(root, 'build', 'icon.png'), '-vf', `scale=${px}:${px}:flags=lanczos`, join(dir, 'ic_launcher.png')]);
}

// 3. Ресурсы и манифест → заготовка APK. Номер версии: 0.4.0 → 400, 1.2.3 → 10203.
const [major, minor, patch] = version.split(/[.-]/).map(Number);
run(tool('aapt2'), ['compile', '--dir', join(out, 'res'), '-o', join(out, 'res.zip')]);
run(tool('aapt2'), ['link', '-I', androidJar, '--manifest', join(app, 'AndroidManifest.xml'), '-A', join(out, 'assets'),
  '--version-code', String(major * 10000 + minor * 100 + patch), '--version-name', version, '-o', join(out, 'base.apk'), join(out, 'res.zip')]);

// 4. Код: MainActivity → classes.dex.
run(java('javac'), ['--release', '11', '-nowarn', '-Xlint:-deprecation', '-classpath', androidJar, '-d', join(out, 'classes'), join(app, 'java', 'com', 'timesyncam', 'tcoder', 'MainActivity.java')]);
const classes = [];
const walk = async (dir) => { for (const e of await readdir(dir, { withFileTypes: true })) e.isDirectory() ? await walk(join(dir, e.name)) : classes.push(join(dir, e.name)); };
await walk(join(out, 'classes'));
run(tool('d8'), ['--release', '--min-api', '24', '--lib', androidJar, '--output', join(out, 'dex'), ...classes]);
run(tool('aapt'), ['add', join(out, 'base.apk'), 'classes.dex'], { cwd: join(out, 'dex'), stdio: ['ignore', 'ignore', 'inherit'] });

// 5. Выравнивание и подпись.
run(tool('zipalign'), ['-p', '-f', '4', join(out, 'base.apk'), join(out, 'aligned.apk')]);
const ks = process.env.TCODER_KEYSTORE
  ? ['--ks', process.env.TCODER_KEYSTORE, '--ks-pass', `env:TCODER_KEYSTORE_PASS`, '--ks-key-alias', process.env.TCODER_KEY_ALIAS ?? 'tcoder']
  : ['--ks', join(homedir(), '.android', 'debug.keystore'), '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey'];
await mkdir(join(root, 'release'), { recursive: true });
const apk = join(root, 'release', `TCoder-${version}.apk`);
run(tool('apksigner'), ['sign', ...ks, '--v4-signing-enabled', 'false', '--out', apk, join(out, 'aligned.apk')]);
run(tool('apksigner'), ['verify', apk]);
console.log(`Готово: ${apk}${process.env.TCODER_KEYSTORE ? '' : ' (подписан отладочным ключом — для релиза задайте TCODER_KEYSTORE)'}`);
