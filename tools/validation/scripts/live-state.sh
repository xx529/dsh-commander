#!/bin/bash
# live Desktop 隔离基线快照 —— 每次探针运行前后各跑一次，输出必须一致。
# 只读：不写 ~/.dsh、不改 live profile。
# 用法：tools/validation/scripts/live-state.sh <输出文件>
set -u
OUT="${1:?usage: live-state.sh <out-file>}"
LIVE="$HOME/.dsh"
DESKTOP_PROFILE="$LIVE/profiles/desktop"

{
  echo "# live-state snapshot $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "## profiles/desktop tree hash (paths+size+mtime)"
  find "$DESKTOP_PROFILE" -type f -not -path '*/node_modules/*/node_modules/*' \
    -exec stat -f '%N|%z|%m' {} \; 2>/dev/null | sort | shasum -a 256
  echo "## profiles/desktop top-level mtimes"
  stat -f '%N|%m' "$DESKTOP_PROFILE"/* 2>/dev/null | sort | shasum -a 256
  echo "## dsh home dotenv stat (size|mtime, no content)"
  stat -f '%N|%z|%m' "$LIVE/.env" 2>/dev/null || echo "missing"
  echo "## desktop profile node_modules top-level count"
  ls "$DESKTOP_PROFILE/node_modules" 2>/dev/null | wc -l
  echo "## capability-settings package version"
  node -e "console.log(require('$DESKTOP_PROFILE/node_modules/dsh-capability-settings/package.json').version)" 2>/dev/null || echo "unreadable"
  echo "## live dsh home top-level entries"
  ls "$LIVE" 2>/dev/null | sort | tr '\n' ' '
  echo
} > "$OUT" 2>&1
echo "wrote $OUT"
