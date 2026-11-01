// Растяжение звука на долю процента — для выравнивания хода часов рекордера.
//
// Запись рекордера с часами, которые спешат на 20 миллионных, за час уходит от видео на 72 мс. Выровненная копия —
// та же запись, растянутая ровно в r = 1 + ppm·10⁻⁶ раз при той же частоте дискретизации: каждый момент u исходной
// записи оказывается в копии в момент u·r. Начало остаётся на месте, как у PluralEyes. ffmpeg так не умеет:
// asetrate принимает только целые герцы, а ошибка в долю герца — это десятки миллисекунд за час.
//
// Ресемплер — многофазный оконный sinc: окно Кайзера, 48 отсчётов, 16 384 фазы. Ошибка момента — не больше
// 1/32768 отсчёта (около микросекунды), подавление вне полосы — около 80 дБ: на слух копия не отличается.
// Высота тона меняется на те же миллионные — это сотые доли цента, их не слышно.
const HALF = 24; // отсчётов ядра по каждую сторону
const PHASES = 16384;
const BETA = 8;
const CUTOFF = 0.92; // доля частоты Найквиста: срез выше 22 кГц при 48 кГц

// I0 Бесселя — для окна Кайзера.
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 40; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

let table: Float32Array | null = null;
let tableCutoff = 0;

// Ядро для каждой фазы: веса 2·HALF отсчётов вокруг точки между отсчётами n и n + 1 с долей frac = p / PHASES.
function kernel(cutoff: number): Float32Array {
  if (table && tableCutoff === cutoff) return table;
  const t = new Float32Array((PHASES + 1) * 2 * HALF);
  const norm = bessel0(BETA);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let k = 0; k < 2 * HALF; k++) {
      const x = k - (HALF - 1) - frac; // расстояние от точки до отсчёта n + k − (HALF − 1)
      const w = Math.abs(x) >= HALF ? 0 : bessel0(BETA * Math.sqrt(1 - (x / HALF) ** 2)) / norm;
      const s = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const v = cutoff * s * w;
      t[p * 2 * HALF + k] = v;
      sum += v;
    }
    // Постоянный уровень без пульсаций: сумма весов каждой фазы — ровно единица.
    for (let k = 0; k < 2 * HALF; k++) t[p * 2 * HALF + k] /= sum;
  }
  table = t;
  tableCutoff = cutoff;
  return t;
}

// Потоковое растяжение: на вход — чередующиеся каналы кусками, на выход — растянутые в ratio раз.
// Выходной отсчёт j берётся из точки j / ratio входа.
export class Stretcher {
  private readonly ch: number;
  private readonly step: number;
  private readonly k: Float32Array;
  private buf: Float32Array; // хвост входа: отсчёты с номера base
  private base = -(HALF - 1); // номер первого отсчёта буфера; слева от начала — тишина
  private filled: number; // сколько кадров в буфере
  private out = 0; // номер следующего выходного кадра

  constructor(channels: number, ratio: number) {
    this.ch = channels;
    this.step = 1 / ratio;
    this.k = kernel(CUTOFF * Math.min(1, ratio));
    this.buf = new Float32Array((HALF - 1) * channels);
    this.filled = HALF - 1;
  }

  // Кадров на выходе всего, для входа из total кадров.
  static outputFrames(total: number, ratio: number): number {
    return Math.round(total * ratio);
  }

  push(input: Float32Array): Float32Array {
    const frames = input.length / this.ch;
    const next = new Float32Array((this.filled + frames) * this.ch);
    next.set(this.buf.subarray(0, this.filled * this.ch));
    next.set(input, this.filled * this.ch);
    this.buf = next;
    this.filled += frames;
    return this.render();
  }

  // Конец входа: справа от последнего отсчёта — тишина.
  finish(totalIn: number): Float32Array {
    const pad = new Float32Array(HALF * this.ch);
    const next = new Float32Array((this.filled + HALF) * this.ch);
    next.set(this.buf.subarray(0, this.filled * this.ch));
    next.set(pad, this.filled * this.ch);
    this.buf = next;
    this.filled += HALF;
    return this.render(Stretcher.outputFrames(totalIn, 1 / this.step));
  }

  private render(limit = Infinity): Float32Array {
    const { ch, k, step } = this;
    const taps = 2 * HALF;
    const chunk: Float32Array[] = [];
    let block = new Float32Array(Math.max(1024, Math.ceil(this.filled / step) + 8) * ch);
    let w = 0;
    for (;;) {
      if (this.out >= limit) break;
      const x = this.out * step;
      const n = Math.floor(x);
      const first = n - (HALF - 1); // номер первого отсчёта ядра
      if (first + taps > this.base + this.filled) break; // ждём вход
      const p = Math.round((x - n) * PHASES);
      const ko = p * taps;
      const bo = (first - this.base) * ch;
      for (let c = 0; c < ch; c++) {
        let s = 0;
        for (let i = 0; i < taps; i++) s += k[ko + i] * this.buf[bo + i * ch + c];
        if (w >= block.length) {
          chunk.push(block);
          block = new Float32Array(block.length);
          w = 0;
        }
        block[w++] = s;
      }
      this.out++;
    }
    // Освобождаем вход, который больше не понадобится.
    const keepFrom = Math.max(this.base, Math.floor(this.out * step) - (HALF - 1));
    const drop = keepFrom - this.base;
    if (drop > 0) {
      this.buf = this.buf.slice(drop * ch, this.filled * ch);
      this.base = keepFrom;
      this.filled -= drop;
    }
    const total = chunk.reduce((s, b) => s + b.length, 0) + w;
    const outArr = new Float32Array(total);
    let o = 0;
    for (const b of chunk) {
      outArr.set(b, o);
      o += b.length;
    }
    outArr.set(block.subarray(0, w), o);
    return outArr;
  }
}

// Растяжение целого массива (для проверок и коротких файлов).
export function stretch(samples: Float32Array, channels: number, ratio: number): Float32Array {
  const s = new Stretcher(channels, ratio);
  const a = s.push(samples);
  const b = s.finish(samples.length / channels);
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
