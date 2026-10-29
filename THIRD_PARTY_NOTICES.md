# Сторонние компоненты

TimesynCam распространяется по лицензии GNU GPL версии 3 или новее (файл `LICENSE`).
В установщик, архив и образ программы для macOS входят следующие сторонние компоненты.

## FFmpeg

Что делает в программе: читает метаданные клипов (`ffprobe`), делает стоп-кадры для предпросмотра и разбирает звук для сверки (`ffmpeg`).
Сборка без `--enable-gpl` и `--enable-nonfree`. FFmpeg подключён как отдельные программы в папке ресурсов `bin` — их можно заменить своей сборкой FFmpeg с теми же именами файлов.

### Windows

- Версия: n9.0.2-37-gae19868753, сборка `win64-lgpl-shared` от [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
- Лицензия: GNU LGPL версии 3 (`licenses/FFmpeg-LGPL-3.0.txt`).
- Исходный код: [FFmpeg на коммите ae19868753](https://github.com/FFmpeg/FFmpeg/commit/ae19868753), скрипты сборки — [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
- Файлы: `resources/bin/ffprobe.exe`, `ffmpeg.exe` и библиотеки FFmpeg (`.dll`).

### macOS

- Версия: [n9.0.2](https://github.com/FFmpeg/FFmpeg/tree/n9.0.2), собрана из исходников скриптом [`scripts/build-ffmpeg-mac.sh`](scripts/build-ffmpeg-mac.sh) — в нём все параметры сборки.
- Лицензия: GNU LGPL версии 2.1 или новее (`licenses/FFmpeg-LGPL-2.1.txt`).
- Без сторонних библиотек: только системные zlib, bzip2, VideoToolbox и AudioToolbox.
- Файлы: `TimesynCam.app/Contents/Resources/bin/ffprobe` и `ffmpeg`.

FFmpeg — торговая марка Fabrice Bellard, автора проекта FFmpeg.

## Electron

- Лицензия: MIT. Лицензии Chromium и других компонентов Electron лежат рядом с программой в файле `LICENSES.chromium.html`.
- Исходный код: [electron/electron](https://github.com/electron/electron).

## React

- Лицензия: MIT.
- Исходный код: [facebook/react](https://github.com/facebook/react).

## jsQR

Чтение QR-кода экрана синхронизации в кадре.

- Лицензия: Apache-2.0.
- Исходный код: [cozmo/jsQR](https://github.com/cozmo/jsQR).

## qrcode-generator

Рисование QR-кода на экране синхронизации.

- Лицензия: MIT.
- Исходный код: [kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator).

## Логотип CloudTips

Логотип CloudTips в README (`docs/images/cloudtips.svg`, знак в центре `docs/images/support-qr.svg`) — товарный знак его владельца. Используется только как ссылка на страницу чаевых проекту и в программу не входит.

## Шрифты и иконки

Интерфейс использует системные шрифты Windows. Иконки нарисованы для TimesynCam и распространяются вместе с программой по её лицензии.
