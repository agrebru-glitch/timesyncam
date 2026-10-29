#!/usr/bin/env bash
# Сборка ffmpeg и ffprobe для macOS из исходников FFmpeg — под LGPL, без --enable-gpl и --enable-nonfree.
# Без сторонних библиотек и статически: в программу кладутся два самостоятельных файла,
# которым нужны только системные библиотеки macOS (никакого Homebrew на компьютере пользователя).
#
#   scripts/build-ffmpeg-mac.sh [папка для ffmpeg и ffprobe, по умолчанию bin]
#
# Лицензия FFmpeg кладётся в build/licenses. Версию можно поменять переменной FFMPEG_VERSION.
set -euo pipefail

VERSION="${FFMPEG_VERSION:-n9.0.2}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/bin}" && cd "${1:-$ROOT/bin}" && pwd)"
SRC="${FFMPEG_SRC:-$ROOT/ffmpeg-src}"
MIN_MACOS=12.0

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch "$VERSION" https://github.com/FFmpeg/FFmpeg.git "$SRC"
fi
cd "$SRC"

# Только системное: zlib и bzip2 (PNG, MOV со сжатыми заголовками), VideoToolbox/AudioToolbox.
# --disable-autodetect не даёт configure подцепить библиотеки Homebrew, если они есть на машине сборки.
platform_flags=()
if [ "$(uname -s)" = Darwin ]; then
  platform_flags+=(--enable-videotoolbox --enable-audiotoolbox
    --extra-cflags="-mmacosx-version-min=$MIN_MACOS" --extra-ldflags="-mmacosx-version-min=$MIN_MACOS")
fi

./configure \
  --disable-autodetect --enable-zlib --enable-bzlib \
  --disable-ffplay --disable-doc --disable-network --disable-debug \
  --enable-static --disable-shared \
  "${platform_flags[@]}"

make -j"$(getconf _NPROCESSORS_ONLN)" ffmpeg ffprobe

version="$(./ffprobe -version)"
if grep -qE -- '--enable-(gpl|nonfree)' <<<"$version"; then
  echo 'Сборка FFmpeg не LGPL' >&2
  exit 1
fi

cp ffmpeg ffprobe "$OUT/"
mkdir -p "$ROOT/build/licenses"
cp COPYING.LGPLv2.1 "$ROOT/build/licenses/FFmpeg-LGPL-2.1.txt"

if [ "$(uname -s)" = Darwin ]; then
  # Проверка: ничего, кроме системных библиотек.
  if otool -L "$OUT/ffprobe" "$OUT/ffmpeg" | tail -n +2 | grep -vE '^[^[:space:]]|^[[:space:]]+(/usr/lib/|/System/)'; then
    echo 'ffmpeg ссылается на несистемные библиотеки' >&2
    exit 1
  fi
fi

head -n 1 <<<"$version"
echo "ffmpeg и ffprobe → $OUT"
