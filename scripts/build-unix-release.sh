#!/usr/bin/env bash
# Build a native Linux or macOS package on the current host.
set -euo pipefail

VERSION="${1:-dev}"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_ROOT="$PROJECT_ROOT/release"
PLATFORM="$(uname -s)"
ARCHITECTURE="$(uname -m)"

case "$PLATFORM" in
  Darwin)
    case "$ARCHITECTURE" in
      arm64) TARGET="macOS-arm64" ;;
      x86_64) TARGET="macOS-x64" ;;
      *) echo "Unsupported macOS architecture: $ARCHITECTURE" >&2; exit 2 ;;
    esac
    ;;
  Linux)
    case "$ARCHITECTURE" in
      x86_64|amd64) TARGET="Linux-x86_64" ;;
      *) echo "Unsupported Linux architecture: $ARCHITECTURE" >&2; exit 2 ;;
    esac
    ;;
  *)
    echo "This script supports only Linux and macOS." >&2
    exit 2
    ;;
esac

cd "$PROJECT_ROOT"
rm -rf "$DIST_ROOT" build dist
mkdir -p "$DIST_ROOT"

python -m pip install --upgrade "pip<25"
python -m pip install -r requirements.txt "pyinstaller==6.6.0"
export PYTHONPATH="$PROJECT_ROOT/vendor${PYTHONPATH:+:$PYTHONPATH}"

PYINSTALLER_ARGS=(
  --noconfirm
  --clean
  --onedir
  --windowed
  --name BaiduPhotoSync
  --paths vendor
  --collect-submodules pybaiduphoto
  --collect-all PySide6.QtWebEngineCore
  --collect-all PySide6.QtWebEngineWidgets
  --collect-submodules keyring
  --copy-metadata keyring
  --hidden-import file_client_worker
  --hidden-import video_compression
  --hidden-import ffmpeg_downloader
  --hidden-import session_store
  --hidden-import platform_services
  --hidden-import download_cache
  --hidden-import web_login
  --add-data "assets:assets"
  --add-data "vendor:vendor"
)

python -m PyInstaller "${PYINSTALLER_ARGS[@]}" app.py

if [[ "$PLATFORM" == "Darwin" ]]; then
  APP_BUNDLE="$PROJECT_ROOT/dist/BaiduPhotoSync.app"
  if [[ ! -d "$APP_BUNDLE" ]]; then
    echo "PyInstaller did not produce the expected macOS app bundle." >&2
    exit 1
  fi
  OUTPUT="$DIST_ROOT/BaiduPhotoSync-$VERSION-$TARGET.app.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP_BUNDLE" "$OUTPUT"
else
  APP_DIRECTORY="$PROJECT_ROOT/dist/BaiduPhotoSync"
  if [[ ! -x "$APP_DIRECTORY/BaiduPhotoSync" ]]; then
    echo "PyInstaller did not produce the expected Linux executable." >&2
    exit 1
  fi
  OUTPUT="$DIST_ROOT/BaiduPhotoSync-$VERSION-$TARGET.tar.gz"
  tar -C "$PROJECT_ROOT/dist" -czf "$OUTPUT" BaiduPhotoSync
fi

sha256sum "$OUTPUT" 2>/dev/null || shasum -a 256 "$OUTPUT"
printf 'Release artifact: %s\n' "$OUTPUT"
