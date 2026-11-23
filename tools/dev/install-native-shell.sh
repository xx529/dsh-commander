#!/usr/bin/env bash
# 原生壳安装预检（只读）：检查构建产物/签名/profile 现状，并打印用户可执行的安装命令。
# 不写 ~/.dsh、不重启 DSH、不调用 dsh plugin。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="$ROOT/packages/dsh-commander"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
esac
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
SHELL_BIN="$PKG/native/dist/${PLATFORM}-${ARCH}/dsh-commander-shell"
PROFILE_DIR="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
INSTALLED="$PROFILE_DIR/node_modules/dsh-commander"
missing=0

check() {
  local label="$1" path="$2"
  if [ -e "$path" ]; then
    echo "  OK   $label"
  else
    echo "  MISS $label  ($path)"
    missing=$((missing + 1))
  fi
}

echo "[preflight] package: $PKG"
echo "[preflight] builds:"
check "lib/host/index.js" "$PKG/lib/host/index.js"
check "lib/client.js" "$PKG/lib/client.js"
check "lib/window.js" "$PKG/lib/window.js"
check "native shell (${PLATFORM}-${ARCH})" "$SHELL_BIN"

if [ -x "$SHELL_BIN" ]; then
  if codesign --verify --verbose=1 "$SHELL_BIN" >/dev/null 2>&1; then
    echo "  OK   codesign valid ($(codesign -dv --verbose=2 "$SHELL_BIN" 2>&1 | awk -F= '/^Signature=/{print $2}'))"
  else
    echo "  WARN codesign invalid; run: codesign --force --sign - \"$SHELL_BIN\""
  fi
fi

echo "[preflight] profile: $PROFILE_DIR"
if [ -d "$PROFILE_DIR" ]; then
  echo "  OK   profile exists"
  if [ -d "$INSTALLED" ]; then
    echo "  OK   dsh-commander installed ($(readlink "$INSTALLED" 2>/dev/null || echo 'copied dir'))"
  else
    echo "  INFO dsh-commander not installed in this profile"
  fi
else
  echo "  INFO profile not found (first install?)"
fi

echo
if [ "$missing" -eq 0 ]; then
  echo "[preflight] PASS — ready to install. Commands (run in your terminal):"
  echo "  dsh plugin --profile desktop remove dsh-commander"
  echo "  dsh plugin --profile desktop add $PKG"
  echo "  # restart DSH"
  echo "  curl -s \"\$DSH_WEB_URL/commander/health\"   # expect nativeShell:\"running\""
else
  echo "[preflight] FAIL — missing $missing artifact(s). Run:"
  echo "  pnpm --filter dsh-commander build && pnpm --filter dsh-commander build:native"
  exit 2
fi
