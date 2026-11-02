import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildClipMeta } from '../src/core/clipMeta.ts';
import { FINE_SR } from '../src/core/audioFeatures.ts';
import { audioSamples, clipTiming } from '../src/main/audio.ts';
import { probe, runTool } from '../src/main/ffmpeg.ts';

const ffmpeg = async (args: string[]) => {
  const r = await runTool('ffmpeg', ['-v', 'error', '-y', ...args], 60000);
  assert.equal(r.code, 0, r.stderr);
};

// Как у телефона realme: видео с нуля, а звук в файле начинается позже (там — на 0,22 с). Монтажка ставит звук
// на это место внутри клипа; сверка должна считать так же — и при разборе с начала, и в окнах с перемоткой.
test('Звук в файле начинается позже видео: все разборы — по времени клипа', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tsc-offset-'));
  try {
    const path = join(dir, 'phone.mov');
    await ffmpeg(['-f', 'lavfi', '-i', 'color=black:s=64x64:r=25:d=4', '-itsoffset', '0.25', '-f', 'lavfi', '-i', 'anoisesrc=d=3.75:c=pink:r=48000:a=0.5:seed=7',
      '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', path]);
    const meta = buildClipMeta({ id: 'p', path, name: 'phone.mov', sizeBytes: 1, mtimeMs: 0, probe: await probe(path), sony: null, proxyPath: null });
    assert.ok(Math.abs(meta.audioStartSec! - 0.25) < 1e-3, `звук с ${meta.audioStartSec}`);
    const timing = clipTiming(meta);

    // С начала клипа: четверть секунды тишины, потом звук.
    const head = (await audioSamples(path, 0, 3, 0, timing))!;
    const lead = Math.round(0.25 * FINE_SR);
    assert.ok(head.subarray(0, lead - 10).every((v) => v === 0));
    assert.ok(head.subarray(lead + 10, lead + 500).some((v) => Math.abs(v) > 0.01));

    // Окно с перемоткой совпадает с тем же местом разбора с начала — сэмпл в сэмпл.
    const same = (x: Float32Array, at: number) => {
      let worst = 0;
      for (let i = 0; i < x.length && at + i < head.length; i++) worst = Math.max(worst, Math.abs(x[i] - head[at + i]));
      return worst;
    };
    assert.ok(same((await audioSamples(path, 1.5, 1, 0, timing))!, Math.round(1.5 * FINE_SR)) < 1e-3);
    // Окно, начатое до первого сэмпла звука, — тоже.
    assert.ok(same((await audioSamples(path, 0.1, 1, 0, timing))!, Math.round(0.1 * FINE_SR)) < 1e-3);

    // Звук, вынутый в отдельный файл (так он лежит в расширенном отчёте), — по тому же времени клипа.
    const copy = join(dir, 'phone.wav');
    await ffmpeg(['-i', path, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', copy]);
    const fromCopy = { ...timing, copy: true };
    assert.ok(same((await audioSamples(copy, 1.5, 1, 0, fromCopy))!, Math.round(1.5 * FINE_SR)) < 1e-3);
    assert.ok(same((await audioSamples(copy, 0, 1, 0, fromCopy))!, 0) < 1e-3);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
