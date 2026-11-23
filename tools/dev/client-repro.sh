#!/bin/bash
# 隔离 web Host + 无头 Chrome 复现脚本（client 半加载/渲染排查）
#
# 用法：bash tools/dev/client-repro.sh
#   PROBE_ROOT=/tmp/client-repro（默认）  OUTDIR 可覆盖诊断产物目录
# 不碰 live Desktop；Chrome 用独立 user-data-dir，结束关闭。
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_ROOT="${PROBE_ROOT:-/tmp/client-repro}"
DSH_HOME="$PROBE_ROOT/home"; DSH_AGENTS_HOME="$PROBE_ROOT/agents"
PROFILE=crepro
OUT="${OUTDIR:-$PROBE_ROOT/report}"
export DSH_HOME DSH_AGENTS_HOME
mkdir -p "$OUT" "$PROBE_ROOT"
CMDS="$OUT/commands.log"; : > "$CMDS"
log() { echo "[client-repro] $*"; }
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

# 1) build
( cd "$REPO" && pnpm --filter dsh-commander build ) > "$OUT/01-build.log" 2>&1
BUILD_EXIT=$?
echo "build exit=$BUILD_EXIT" >> "$CMDS"
[ "$BUILD_EXIT" -ne 0 ] && { log "build failed"; exit 2; }

# 2) fresh isolated profile + install
rm -rf "$DSH_HOME" "$DSH_AGENTS_HOME"
mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$PROBE_ROOT/ws"
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --from-default-profile web --dump-default-config > "$OUT/02-default-config.yml" 2> "$OUT/02-default-config.err"
echo "init profile exit=$?" >> "$CMDS"
DSH_BIN="$(command -v dsh || true)"
CLI_DIR=""
if [ -n "$DSH_BIN" ] && [ -f "$DSH_BIN" ]; then
  CLI_BINJS="$(sed -n 's#.*"\([^"]*lib/node_modules/@deepseek-ai/dsh/lib/bin.js\)".*#\1#p' "$DSH_BIN" | head -1)"
  CLI_BINJS="${CLI_BINJS//\$HOME/$HOME}"
  [ -f "$CLI_BINJS" ] && CLI_DIR="$(dirname "$(dirname "$CLI_BINJS")")"
fi
[ -z "$CLI_DIR" ] && CLI_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh 2>/dev/null | tail -1)"
if [ -n "$CLI_DIR" ] && [ -d "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" ]; then
  mkdir -p "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai"
  ln -sfn "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai/dsh-client-ui-chat"
fi
env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX \
  npm_config_registry="${npm_config_registry:-https://mirrors.cloud.tencent.com/npm/}" \
  npm_config_store_dir="$PROBE_ROOT/.pnpm-store" \
  dsh plugin --profile "$PROFILE" add "file:$REPO/packages/dsh-commander" > "$OUT/03-plugin-add.log" 2>&1
echo "plugin add exit=$?" >> "$CMDS"

# 3) boot web host（保持运行，供无头 Chrome 访问）
COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --port 0 --no-open > "$OUT/04-boot.out" 2> "$OUT/04-boot.err" &
BOOT_PID=$!
BASE=""
for _ in $(seq 1 160); do
  BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$OUT/04-boot.out" | head -1)
  [ -n "$BASE" ] && break
  sleep 0.25
done
if [ -z "$BASE" ]; then log "FAIL boot"; cat "$OUT/04-boot.err"; exit 2; fi
TOKEN=$(sed -n 's#^dsh web: http://[^/]*/?token=\(.*\)$#\1#p' "$OUT/04-boot.out" | head -1)
echo "BASE=$BASE token_len=${#TOKEN}" >> "$CMDS"
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true)
  [ "$code" = "200" ] && break
  sleep 0.25
done
curl -s "$BASE/commander/health" -o "$OUT/05-health.json" -w 'health http=%{http_code}\n' >> "$CMDS" 2>&1

# 3b) 页面 + client bundle 直接抓取
rm -f "$PROBE_ROOT/.jar"
curl -sL -c "$PROBE_ROOT/.jar" -b "$PROBE_ROOT/.jar" -o "$OUT/06-page.html" -w 'page http=%{http_code} bytes=%{size_download}\n' "$BASE/?token=$TOKEN" >> "$CMDS" 2>&1
BUNDLE_URL=$(node - "$OUT/06-page.html" <<'NODE' 2>/dev/null
const fs = require('node:fs')
const html = fs.readFileSync(process.argv[2], 'utf8')
const m = html.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\});?<\/script>/s)
if (!m) { console.log(''); process.exit(0) }
const boot = JSON.parse(m[1])
const row = (boot.entries || []).find((e) => e.id === 'dsh-commander')
console.log(row === undefined ? '' : row.url)
NODE
)
if [ -n "$BUNDLE_URL" ]; then
  curl -s -b "$PROBE_ROOT/.jar" -o "$OUT/07-client-served.js" -w "client.js(bundle) http=%{http_code} bytes=%{size_download}\n" "$BASE/$BUNDLE_URL" >> "$CMDS" 2>&1
else
  echo "client.js(bundle) NOT FOUND in page boot graph" >> "$CMDS"
fi

# 4) 无头 Chrome CDP 复现
log "run headless chrome CDP probe"
node "$REPO/tools/dev/cdp-probe.mjs" --url "$BASE/?token=$TOKEN" --out "$OUT/cdp" --user-data-dir "$PROBE_ROOT/chrome" --port 9333 > "$OUT/08-cdp-stdout.txt" 2>&1
CDP_EXIT=$?
echo "cdp-probe exit=$CDP_EXIT" >> "$CMDS"

# 5) 收尾
kill "$BOOT_PID" 2>/dev/null
wait "$BOOT_PID" 2>/dev/null
log "done: $OUT"
head -60 "$OUT/08-cdp-stdout.txt" 2>/dev/null || true
echo "CDP_EXIT=$CDP_EXIT"
