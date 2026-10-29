import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Кнопки «Скачать» в README ведут прямо на файлы релиза — при смене версии их нужно обновить.
test('ссылки на скачивание в README — на текущую версию', () => {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const links = [...readme.matchAll(/releases\/download\/(v[^/]+)\/([^")\s]+)/g)];
  assert.ok(links.length >= 4, 'в README нет ссылок на файлы релиза');
  for (const [, tag, file] of links) {
    assert.equal(tag, `v${version}`, `ссылка на ${file} ведёт в релиз ${tag}`);
    assert.ok(file.includes(version), `${file}: в имени не версия ${version}`);
  }
});
