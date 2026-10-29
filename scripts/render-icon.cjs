// Рисует PNG-иконки из build/icon.svg: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8');

async function render(win, size) {
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = ${size};
      c.height = ${size};
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, ${size}, ${size});
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('svg'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(svg)});
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 100, height: 100 });
  await win.loadURL('data:text/html,<html><body></body></html>');
  writeFileSync(join(root, 'build', 'icon.png'), await render(win, 512));
  mkdirSync(join(root, 'docs', 'images'), { recursive: true });
  writeFileSync(join(root, 'docs', 'images', 'icon.png'), await render(win, 128));
  app.quit();
});
