#!/usr/bin/env bash
# 构建 macOS 原生壳（Tauri 2）并复制到 native/dist/<platform>-<arch>/，
# 供 Host 的 supervisor 在运行时 spawn。仅构建机需要 Rust 工具链。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # packages/dsh-commander
TAURI="$ROOT/native/tauri"

node_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "x64" ;;
    *) uname -m ;;
  esac
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 2 ;;
esac
arch="$(node_arch)"
dest="$ROOT/native/dist/${platform}-${arch}"

# 沙箱/本机开发时可用工作区内的 CARGO_HOME，避免写 ~/.cargo。
export CARGO_HOME="${CARGO_HOME:-$ROOT/../../.cargo-home}"
# 产物放仓库根 target/，避免 1.5GB 构建缓存被 pnpm file: 安装复制进 profile。
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/../../target/native-shell}"

echo "[build:native] cargo build --release ($platform-$arch)"
cd "$TAURI"
cargo build --release

mkdir -p "$dest"
cp "$CARGO_TARGET_DIR/release/dsh-commander-shell" "$dest/dsh-commander-shell"
chmod +x "$dest/dsh-commander-shell"
if [ "$platform" = "darwin" ]; then
  # linker-signed 的 ad-hoc 签名在部分 macOS 上会被判定无效（SIGKILL Code Signature Invalid）；
  # 显式重签一次，产物可直接运行。
  if ! codesign --force --sign - "$dest/dsh-commander-shell" >/dev/null 2>&1; then
    echo "[build:native] warning: codesign failed; the shell may be killed by Gatekeeper (Code Signature Invalid)" >&2
  fi
fi
echo "[build:native] wrote $dest/dsh-commander-shell"
