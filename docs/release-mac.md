# Сборка для macOS и добавление в релиз

Релиз на GitHub собирается для Windows. Версия для Mac с Apple Silicon собирается на самом Mac и докладывается в тот же релиз. Подпись — ad-hoc, сертификаты Apple не нужны.

Нужны: Xcode Command Line Tools, Node.js LTS, Git и `gh`, вошедший в GitHub (`gh auth status`). Mac с процессором Apple Silicon. Первая сборка FFmpeg занимает несколько минут.

## Сборка

Метка версии — та, что указана в релизе:

```bash
TAG=v0.4.1
git clone --depth 1 --branch "$TAG" https://github.com/agrebru-glitch/timesyncam.git timesyncam-mac
cd timesyncam-mac
npm ci
npm run typecheck
FFMPEG_VERSION=n9.0.2 scripts/build-ffmpeg-mac.sh bin
rm -f build/licenses/FFmpeg-LGPL-3.0.txt
bin/ffprobe -version | head -n 1
bin/ffprobe -version | grep -E -- '--enable-(gpl|nonfree)' && echo 'СТОП: сборка FFmpeg не LGPL'
lipo -archs bin/ffmpeg bin/ffprobe
PATH="$PWD/bin:$PATH" npm test
npm run build
npx electron-builder --mac --arm64 --publish never
```

`lipo` должен показать `arm64` у обоих файлов, строка «СТОП» появиться не должна, тесты — без ошибок. Если что-то из этого не так, в релиз не докладывать.

## Проверка программы

```bash
app=$(ls -d release/mac*/TimesynCam.app)
codesign --verify --deep --strict --verbose=2 "$app"
"$app/Contents/Resources/bin/ffprobe" -version | head -n 1
ls "$app/Contents/Resources/licenses"
mkdir -p smoke/cam1 smoke/cam2
bin/ffmpeg -v error -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 6 -c:v mpeg4 -q:v 5 -c:a aac -timecode 10:00:00:00 smoke/cam1/A001.MP4
bin/ffmpeg -v error -f lavfi -i testsrc=size=1280x720:rate=25 -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 6 -c:v prores_ks -profile:v 0 -c:a pcm_s16le -timecode 10:00:02:00 smoke/cam2/B001.MOV
SYNC_AUTOLOAD="$PWD/smoke/cam1|$PWD/smoke/cam2" SYNC_AUTOSYNC=1 SYNC_SHOT="$PWD/smoke/window.png" SYNC_SHOT_DELAY=15000 "$app/Contents/MacOS/TimesynCam"
ls -la smoke/window.png
```

Программа сама закроется примерно через 15 секунд и оставит снимок окна `smoke/window.png`. На снимке должны быть обе камеры на таймлинии.

## Добавление в релиз

```bash
dmg=$(ls release/TimesynCam-*-mac-arm64.dmg)
gh release download "$TAG" -R agrebru-glitch/timesyncam -p SHA256SUMS.txt -D sums --clobber
shasum -a 256 "$dmg" | sed 's|release/||' >> sums/SHA256SUMS.txt
gh release upload "$TAG" -R agrebru-glitch/timesyncam "$dmg" sums/SHA256SUMS.txt --clobber
gh release view "$TAG" -R agrebru-glitch/timesyncam --json assets --jq '.assets[].name'
```

В списке должны быть `TimesynCam-<версия>-mac-arm64.dmg` и `SHA256SUMS.txt`, а в `SHA256SUMS.txt` — строка с этим файлом ровно одна.

В README кнопка «Скачать для macOS» на время между публикацией и этим шагом ведёт на страницу прошлого релиза. После добавления её нужно перевести на новый файл.
