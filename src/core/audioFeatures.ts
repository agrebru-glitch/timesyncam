// Отпечаток звука и точная сверка. Всё автоматически: программа сама выбирает канал и полосы частот.
//
// Отпечаток: звук делится на 12 полос от 150 Гц до 7 кГц, в каждой отмечаются резкие подъёмы громкости
// относительно обычного уровня полосы (хлопок, удар, свисток, начало слова). Ниже 150 Гц — ветер и гул,
// они не участвуют. Шум, который звучит ровно (трибуны, гул зала), подъёмов почти не даёт.
//
// Точная сверка (GCC-PHAT): сравнение самой волны на 48 кГц с выравниванием по фазе — стандартный способ
// находить задержку между микрофонами. Даёт точность в доли миллисекунды.

export const FEAT_RATE = 100; // кадров отпечатка в секунду
export const FEAT_SR = 16000;
export const FINE_SR = 48000;
const WIN = 512;
const BANDS = 12;
const F_LOW = 150;
const F_HIGH = 7000;

export interface Features {
  frames: number;
  bands: number;
  data: Float32Array; // кадры × полосы
}

// Быстрое преобразование Фурье по месту, длина — степень двойки.
export function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

export function nextPow2(n: number): number {
  let s = 1;
  while (s < n) s <<= 1;
  return s;
}

const hann = (() => {
  const w = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
  return w;
})();

function bandBins(sr: number): number[] {
  const edges: number[] = [];
  for (let i = 0; i <= BANDS; i++) {
    const f = F_LOW * (F_HIGH / F_LOW) ** (i / BANDS);
    edges.push(Math.max(1, Math.min(WIN / 2, Math.round((f * WIN) / sr))));
  }
  return edges;
}

export interface RawFeatures {
  feat: Features;
  clarity: number; // насколько звук «разборчивый»: во сколько раз сильные атаки выше обычного уровня
}

export function bandFeatures(samples: Float32Array, sr: number): RawFeatures {
  const hop = Math.round(sr / FEAT_RATE);
  const n = samples.length >= WIN ? Math.floor((samples.length - WIN) / hop) + 1 : 0;
  const edges = bandBins(sr);
  const energy = new Float64Array(n * BANDS);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  for (let t = 0; t < n; t++) {
    const off = t * hop;
    for (let i = 0; i < WIN; i++) {
      re[i] = samples[off + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im, false);
    for (let b = 0; b < BANDS; b++) {
      let s = 0;
      for (let k = edges[b]; k < Math.max(edges[b] + 2, edges[b + 1]); k++) s += re[k] * re[k] + im[k] * im[k];
      energy[t * BANDS + b] = s;
    }
  }
  // Громкость полосы относительно её обычного уровня: ровный шум даёт около нуля, хлопок — сильный всплеск.
  const column = new Float64Array(n);
  for (let b = 0; b < BANDS; b++) {
    for (let t = 0; t < n; t++) column[t] = energy[t * BANDS + b];
    const sortedCol = Array.from(column).sort((x, y) => x - y);
    const floor = (sortedCol[Math.floor(sortedCol.length / 2)] ?? 0) + 1e-12;
    for (let t = 0; t < n; t++) energy[t * BANDS + b] = Math.log(1 + energy[t * BANDS + b] / floor);
  }
  const data = new Float32Array(n * BANDS);
  const summed = new Float64Array(n);
  for (let t = 1; t < n; t++) {
    for (let b = 0; b < BANDS; b++) {
      const v = Math.max(0, energy[t * BANDS + b] - energy[(t - 1) * BANDS + b]);
      data[t * BANDS + b] = v;
      summed[t] += v;
    }
  }
  // Оставляем только явные атаки: в каждой полосе всё, что не выше обычного «дрожания» шума, обнуляется.
  // Тогда ровный шум вообще не участвует в сравнении, а масштаб у всех полос общий.
  let total = 0;
  const col = new Float64Array(n);
  for (let b = 0; b < BANDS; b++) {
    for (let t = 0; t < n; t++) col[t] = data[t * BANDS + b];
    const sortedB = Array.from(col).sort((x, y) => x - y);
    const med = sortedB[Math.floor(sortedB.length / 2)] ?? 0;
    const dev = Array.from(col, (v) => Math.abs(v - med)).sort((x, y) => x - y);
    const mad = dev[Math.floor(dev.length / 2)] ?? 0;
    const thr = med + 2 * mad;
    let mean = 0;
    for (let t = 0; t < n; t++) {
      col[t] = Math.max(0, col[t] - thr);
      mean += col[t];
    }
    mean /= n || 1;
    for (let t = 0; t < n; t++) {
      const v = col[t] - mean;
      data[t * BANDS + b] = v;
      total += v * v;
    }
  }
  const sd = Math.sqrt(total / (n * BANDS || 1)) || 1;
  for (let i = 0; i < data.length; i++) data[i] /= sd;
  const sorted = Array.from(summed).sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
  const clarity = sorted.length ? p(0.98) / (p(0.5) + 1e-3) : 0;
  return { feat: { frames: n, bands: BANDS, data }, clarity };
}

// Каналы с разным звуком (внешний микрофон и встроенный) — берём тот, где атаки звука чётче.
export function pickChannel(channels: Float32Array[], sr: number, peakOf: (s: Float32Array) => number, silenceDb: number): { feat: Features; channel: number; peakDb: number } {
  let best: { feat: Features; channel: number; peakDb: number; clarity: number } | null = null;
  let loudest = -Infinity;
  channels.forEach((ch, i) => {
    const peak = peakOf(ch);
    loudest = Math.max(loudest, peak);
    if (peak < silenceDb) return;
    if (i > 0 && channels.length === 2 && identical(channels[0], ch)) return;
    const f = bandFeatures(ch, sr);
    if (!best || f.clarity > best.clarity) best = { feat: f.feat, channel: i, peakDb: peak, clarity: f.clarity };
  });
  if (best) {
    const b = best as { feat: Features; channel: number; peakDb: number };
    return { feat: b.feat, channel: b.channel, peakDb: b.peakDb };
  }
  return { feat: bandFeatures(channels[0], sr).feat, channel: 0, peakDb: loudest };
}

function identical(a: Float32Array, b: Float32Array): boolean {
  const n = Math.min(a.length, b.length, 4000);
  for (let i = 0; i < n; i += 7) if (Math.abs(a[i] - b[i]) > 1e-6) return false;
  return true;
}

// Сравнение отпечатков при всех сдвигах сразу: score(k) — насколько target[0..] совпадает с ref[k..].
export interface ScoreTable {
  lo: number;
  scores: Float64Array;
}

export function xcorrFeatures(target: Features, ref: Features, minOverlap: number): ScoreTable | null {
  const n = target.frames;
  const m = ref.frames;
  const B = target.bands;
  if (n < 2 || m < 2 || n + m - 2 * minOverlap < 0) return null;
  const size = nextPow2(n + m);
  const accR = new Float64Array(size);
  const accI = new Float64Array(size);
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  for (let b = 0; b < B; b++) {
    ar.fill(0);
    ai.fill(0);
    br.fill(0);
    bi.fill(0);
    for (let j = 0; j < m; j++) ar[j] = ref.data[j * B + b];
    for (let i = 0; i < n; i++) br[i] = target.data[i * B + b];
    fft(ar, ai, false);
    fft(br, bi, false);
    for (let k = 0; k < size; k++) {
      accR[k] += ar[k] * br[k] + ai[k] * bi[k];
      accI[k] += ai[k] * br[k] - ar[k] * bi[k];
    }
  }
  fft(accR, accI, true);
  const et = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let b = 0; b < B; b++) s += target.data[i * B + b] ** 2;
    et[i + 1] = et[i] + s;
  }
  const er = new Float64Array(m + 1);
  for (let j = 0; j < m; j++) {
    let s = 0;
    for (let b = 0; b < B; b++) s += ref.data[j * B + b] ** 2;
    er[j + 1] = er[j] + s;
  }
  const lo = -(n - minOverlap);
  const hi = m - minOverlap;
  const scores = new Float64Array(hi - lo + 1);
  for (let k = lo; k <= hi; k++) {
    const i0 = Math.max(0, -k);
    const i1 = Math.min(n, m - k);
    const st = et[i1] - et[i0];
    const sr = er[i1 + k] - er[i0 + k];
    scores[k - lo] = st > 0 && sr > 0 ? accR[k >= 0 ? k : size + k] / Math.sqrt(st * sr) : -1;
  }
  return { lo, scores };
}

// Точная задержка между двумя кусками волны. x[0] при нулевом сдвиге совпадает с y[off].
export function gccPhat(x: Float32Array, y: Float32Array, sr: number, off: number, maxLag: number): { lag: number; confidence: number } | null {
  const size = nextPow2(x.length + y.length);
  const xr = new Float64Array(size);
  const xi = new Float64Array(size);
  const yr = new Float64Array(size);
  const yi = new Float64Array(size);
  // Плавные края куска, чтобы обрез не давал ложных щелчков.
  const taper = Math.min(Math.floor(x.length / 10), Math.round(sr * 0.05));
  for (let i = 0; i < x.length; i++) {
    let w = 1;
    if (i < taper) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
    else if (i > x.length - taper) w = 0.5 - 0.5 * Math.cos((Math.PI * (x.length - i)) / taper);
    xr[i] = x[i] * w;
  }
  for (let j = 0; j < y.length; j++) yr[j] = y[j];
  fft(xr, xi, false);
  fft(yr, yi, false);
  const loBin = Math.round((150 * size) / sr);
  const hiBin = Math.round((Math.min(8000, sr / 2 - 1) * size) / sr);
  for (let k = 0; k < size; k++) {
    const f = k <= size / 2 ? k : size - k;
    if (f < loBin || f > hiBin) {
      xr[k] = 0;
      xi[k] = 0;
      continue;
    }
    const gr = yr[k] * xr[k] + yi[k] * xi[k];
    const gi = yi[k] * xr[k] - yr[k] * xi[k];
    const mag = Math.hypot(gr, gi) + 1e-12;
    xr[k] = gr / mag;
    xi[k] = gi / mag;
  }
  fft(xr, xi, true);
  let best = -Infinity;
  let bestK = -1;
  let sum2 = 0;
  let count = 0;
  for (let k = off - maxLag; k <= off + maxLag; k++) {
    if (k < 0 || k >= size) continue;
    const v = xr[k];
    sum2 += v * v;
    count++;
    if (v > best) {
      best = v;
      bestK = k;
    }
  }
  if (bestK < 0 || best <= 0 || count === 0) return null;
  const rms = Math.sqrt(sum2 / count) || 1e-12;
  let frac = 0;
  if (bestK > 0 && bestK < size - 1) {
    const y0 = xr[bestK - 1];
    const y1 = xr[bestK];
    const y2 = xr[bestK + 1];
    const d = y0 - 2 * y1 + y2;
    if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d));
  }
  return { lag: bestK + frac - off, confidence: best / rms };
}
