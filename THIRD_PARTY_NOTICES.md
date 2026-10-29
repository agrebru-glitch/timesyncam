# Сторонние компоненты

TimesynCam распространяется по лицензии GNU GPL версии 3 или новее (файл `LICENSE`).
В установщик и архив программы входят следующие сторонние компоненты.

## FFmpeg

- Что делает в программе: читает метаданные клипов (`ffprobe.exe`) и делает стоп-кадры для предпросмотра (`ffmpeg.exe`).
- Версия: n9.0.2-37-gae19868753, сборка `win64-lgpl-shared` от [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
- Лицензия: GNU LGPL версии 3 (`licenses/FFmpeg-LGPL-3.0.txt`). Сборка без `--enable-gpl` и `--enable-nonfree`.
- Исходный код: [FFmpeg на коммите ae19868753](https://github.com/FFmpeg/FFmpeg/commit/ae19868753), скрипты сборки — [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
- FFmpeg подключён как отдельные программы и библиотеки в папке `resources/bin`. Их можно заменить своей сборкой FFmpeg с теми же именами файлов.

FFmpeg — торговая марка Fabrice Bellard, автора проекта FFmpeg.

## Electron

- Лицензия: MIT. Лицензии Chromium и других компонентов Electron лежат рядом с программой в файле `LICENSES.chromium.html`.
- Исходный код: [electron/electron](https://github.com/electron/electron).

## React

- Лицензия: MIT.
- Исходный код: [facebook/react](https://github.com/facebook/react).

## Шрифты и иконки

Интерфейс использует системные шрифты Windows. Иконки нарисованы для TimesynCam и распространяются вместе с программой по её лицензии.
