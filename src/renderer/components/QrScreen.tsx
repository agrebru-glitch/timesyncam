import { useEffect, useRef } from 'react';
import qrcode from 'qrcode-generator';
import { QR_PERIOD_MS, qrPayload } from '../../core/qrSync.ts';
import { useApp } from '../App.tsx';

// Экран синхронизации: QR-код с точным временем, меняется каждую секунду.
// Камеры снимают его 5–10 секунд — до или после съёмки, не важно: время зашито в коде.
export function QrScreen() {
  const { dispatch } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    let shown = -1;
    let lock: { release: () => Promise<void> } | null = null;
    void (navigator as Navigator & { wakeLock?: { request: (t: string) => Promise<{ release: () => Promise<void> }> } })
      .wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    const draw = () => {
      const slot = Math.floor(Date.now() / QR_PERIOD_MS);
      if (slot !== shown && canvasRef.current) {
        shown = slot;
        const qr = qrcode(0, 'M');
        qr.addData(qrPayload(slot * QR_PERIOD_MS));
        qr.make();
        const n = qr.getModuleCount();
        const cv = canvasRef.current;
        const size = cv.width;
        const cell = size / (n + 8);
        const g = cv.getContext('2d')!;
        g.fillStyle = '#fff';
        g.fillRect(0, 0, size, size);
        g.fillStyle = '#000';
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) if (qr.isDark(r, c)) g.fillRect(Math.floor((c + 4) * cell), Math.floor((r + 4) * cell), Math.ceil(cell), Math.ceil(cell));
        }
        if (clockRef.current) clockRef.current.textContent = new Date(slot * QR_PERIOD_MS).toLocaleTimeString('ru-RU');
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dispatch({ type: 'qr-screen', open: false });
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      void lock?.release();
    };
  }, [dispatch]);

  return (
    <div className="qr-screen" ref={wrapRef}>
      <canvas ref={canvasRef} width={900} height={900} />
      <div className="qr-clock" ref={clockRef} />
      <p className="qr-hint">Наведите камеры на экран и снимите 5–10 секунд — до или после съёмки. Потом на таймлинии: правая кнопка по клипу → «Выбрать контрольным кадром».</p>
      <div className="qr-bar">
        <button className="btn" onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void wrapRef.current?.requestFullscreen())}>Во весь экран</button>
        <button className="btn" onClick={() => dispatch({ type: 'qr-screen', open: false })}>Закрыть (Esc)</button>
      </div>
    </div>
  );
}
