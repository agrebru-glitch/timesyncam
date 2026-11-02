// TCoder: экран синхронизации на телефоне — тот же QR-код, что в TimesynCam (формат — src/core/qrSync.ts),
// но время — по часам телефона. Камеры снимают его 5–10 секунд, и программа ставит их клипы по моменту смены кода.
import qrcode from 'qrcode-generator';
import { QR_PERIOD_MS, qrPayload } from '../../../src/core/qrSync.ts';

declare const __APP_VERSION__: string;
declare global {
  interface Window {
    TCoder?: { bright(on: boolean): void }; // мост в MainActivity.java
  }
}

const canvas = document.getElementById('qr') as HTMLCanvasElement;
const clock = document.getElementById('clock')!;
let shown = -1;

function draw() {
  const slot = Math.floor(Date.now() / QR_PERIOD_MS);
  if (slot !== shown) {
    shown = slot;
    const qr = qrcode(0, 'M');
    qr.addData(qrPayload(slot * QR_PERIOD_MS));
    qr.make();
    const n = qr.getModuleCount();
    const size = canvas.width;
    const cell = size / (n + 8);
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect(Math.floor((c + 4) * cell), Math.floor((r + 4) * cell), Math.ceil(cell), Math.ceil(cell));
    }
    clock.textContent = new Date(slot * QR_PERIOD_MS).toLocaleTimeString('ru-RU');
  }
  requestAnimationFrame(draw);
}

// «О программе» — по #about: так кнопка «Назад» телефона возвращает к QR-коду.
function route() {
  const about = location.hash === '#about';
  document.body.classList.toggle('about', about);
  window.TCoder?.bright(!about);
  if (about) window.scrollTo(0, 0);
}

document.getElementById('version')!.textContent = __APP_VERSION__;
document.getElementById('back')!.addEventListener('click', () => (history.length > 1 ? history.back() : (location.hash = '')));
window.addEventListener('hashchange', route);
route();
requestAnimationFrame(draw);
