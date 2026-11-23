#!/bin/bash
# M0-0 隔离冒烟：在一次性 DSH_HOME（默认 /tmp，绝不装到 live desktop profile）里安装本地包
# packages/dsh-commander，启动 web Host，验证：
#   a) host 行被加载（`/commander/health` 200 + boot stderr 无失败条目）；
#   b) 页面 200（带 token）、boot graph 含 `dsh-commander` 行（id/inject/immediately）；
#   c) Host 从 /plugins combo 路由返回的 client bundle 头是官方 `window.__ModuleLoader__.load({id:"dsh-commander",…})` 形态。
#
# 用法：
#   bash tools/dev/smoke-m0.sh
#   PROBE_ROOT=/tmp/some-dir OUTDIR=/tmp/m0-evidence bash tools/dev/smoke-m0.sh   # 第三方复跑请用 OUTDIR，默认会写 docs 证据目录
#
# 退出码：0 = 全部断言 PASS；非 0 = 环境/断言失败（详见 artifacts/commands.log）。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_ROOT="${PROBE_ROOT:-/tmp/dsh-commander-m0}"
DSH_HOME="$PROBE_ROOT/home"
DSH_AGENTS_HOME="$PROBE_ROOT/agents"
PROFILE=m0
ART="${OUTDIR:-$REPO/docs/validation/m0-artifacts}"
export DSH_HOME DSH_AGENTS_HOME

mkdir -p "$ART"
CMDS="$ART/commands.log"
: > "$CMDS"
FAILED=0
log() { echo "[smoke-m0] $*"; }
record() { echo "$*" >> "$CMDS"; }
assert() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then record "## ASSERT PASS $name ($actual)"; log "PASS $name ($actual)"; else record "## ASSERT FAIL $name expected=$expected actual=$actual"; log "FAIL $name expected=$expected actual=$actual"; FAILED=1; fi
}
# 隔离 live Desktop 上下文变量
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

# ---- 0) 环境版本 + live 前基线 ----
{
  echo "# M0-0 构建/冒烟环境 $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "dsh CLI: $(dsh --version 2>/dev/null)"
  echo "Desktop: $(plutil -extract CFBundleShortVersionString raw '/Applications/DeepSeek Harness.app/Contents/Info.plist' 2>/dev/null || echo unavailable)"
  echo "node(PATH): $(node --version)"; echo "pnpm: $(pnpm --version 2>/dev/null)"
  echo "typescript: $(node -e "console.log(require('$REPO/packages/dsh-commander/node_modules/typescript/package.json').version)" 2>/dev/null)"
  echo "tsdown: $(node -e "console.log(require('$REPO/packages/dsh-commander/node_modules/tsdown/package.json').version)" 2>/dev/null)"
  echo "PROBE_ROOT=$PROBE_ROOT"; echo "DSH_HOME=$DSH_HOME"; echo "DSH_AGENTS_HOME=$DSH_AGENTS_HOME"
  echo "git rev: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unavailable)"
} > "$ART/env-versions.txt" 2>&1
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-pre.txt" >/dev/null 2>&1 || true
record "## env -> $ART/env-versions.txt"

# ---- 1) 构建本地包（BUILD_MODE=spike 用 tools/dev/spike 占位；real 用 src/host+src/client 真实实现） ----
BUILD_MODE="${BUILD_MODE:-spike}"
log "build package (mode=$BUILD_MODE)"
if [ "$BUILD_MODE" = "real" ]; then
  ( cd "$REPO" && pnpm --filter dsh-commander build ) > "$ART/01-build.log" 2>&1
  BUILD_EXIT=$?
  record "\$ pnpm --filter dsh-commander build   # (BUILD_MODE=real) exit=$BUILD_EXIT"
else
  bash "$REPO/tools/dev/spike-build.sh" > "$ART/01-build.log" 2>&1
  BUILD_EXIT=$?
  record "\$ bash tools/dev/spike-build.sh   # (BUILD_MODE=spike) exit=$BUILD_EXIT"
fi
assert "build exit" "0" "$BUILD_EXIT"
[ "$BUILD_EXIT" -ne 0 ] && { log "build failed; see $ART/01-build.log"; exit 2; }

# ---- 2) 全新隔离 profile（web 模板）+ 安装本地包 ----
log "init isolated profile '$PROFILE' at $PROBE_ROOT"
rm -rf "$PROBE_ROOT"
mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME"
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --from-default-profile web --dump-default-config > "$ART/02-default-config.yml" 2> "$ART/02-default-config.err"
INIT_EXIT=$?
record "\$ dsh --profile $PROFILE --from-default-profile web --dump-default-config   # exit=$INIT_EXIT ($(wc -l < "$ART/02-default-config.yml" | tr -d ' ') lines)"
assert "init profile exit" "0" "$INIT_EXIT"

# 2b) web 模板的 ui-chat 入口需要 CLI 安装里的 dsh-client-ui-chat（CLI 未直接依赖它）：
#     只读符号链接进探针 profile，消除 "ui-chat entry did not activate" 告警（Host 功能不受影响）。
DSH_BIN="$(command -v dsh || true)"
CLI_DIR=""
if [ -n "$DSH_BIN" ] && [ -f "$DSH_BIN" ]; then
  CLI_BINJS="$(sed -n 's#.*"\([^"]*lib/node_modules/@deepseek-ai/dsh/lib/bin.js\)".*#\1#p' "$DSH_BIN" | head -1)"
  CLI_BINJS="${CLI_BINJS//\$HOME/$HOME}"
  if [ -n "$CLI_BINJS" ] && [ -f "$CLI_BINJS" ]; then CLI_DIR="$(dirname "$(dirname "$CLI_BINJS")")"; fi
fi
if [ -z "$CLI_DIR" ] || [ ! -d "$CLI_DIR" ]; then
  CLI_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh 2>/dev/null | tail -1)"
fi
if [ -n "$CLI_DIR" ] && [ -d "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" ]; then
  mkdir -p "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai"
  ln -sfn "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" \
          "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai/dsh-client-ui-chat"
  record "## linked CLI dsh-client-ui-chat into probe profile: $CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat"
else
  record "## WARN: CLI dsh-client-ui-chat not found; ui-chat entry will warn (Host unaffected)"
fi

log "install local package into isolated profile"
env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX \
  npm_config_registry="${npm_config_registry:-https://mirrors.cloud.tencent.com/npm/}" \
  npm_config_store_dir="$PROBE_ROOT/.pnpm-store" \
  dsh plugin --profile "$PROFILE" add "file:$REPO/packages/dsh-commander" > "$ART/03-plugin-add.log" 2>&1
ADD_EXIT=$?
record "\$ dsh plugin --profile $PROFILE add file:$REPO/packages/dsh-commander   # exit=$ADD_EXIT"
assert "plugin add exit" "0" "$ADD_EXIT"
[ "$ADD_EXIT" -ne 0 ] && { log "plugin add failed; see $ART/03-plugin-add.log"; exit 2; }
cp "$DSH_HOME/profiles/$PROFILE/package.json" "$ART/04-profile-package.json"
node -e "const p=require('$ART/04-profile-package.json'); console.log(JSON.stringify({dependencies:p.dependencies,bundles:p.dsh?.profile?.bundles},null,1))" >> "$CMDS" 2>&1
BUNDLE_PRESENT=$(node -e "const p=require('$ART/04-profile-package.json'); console.log((p.dsh?.profile?.bundles||[]).includes('dsh-commander')?'yes':'no')")
assert "bundle appended to profile" "yes" "$BUNDLE_PRESENT"

# ---- 3) dump-config 含 commander 行 ----
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --dump-config > "$ART/05-dump-config.yml" 2> "$ART/05-dump-config.err"
DUMP_EXIT=$?
grep -n -A3 -E "^- id: commander$" "$ART/05-dump-config.yml" > "$ART/06-dump-config-commander.txt" 2>&1
COMMANDER_ROWS=$(grep -c -E "^- id: commander$" "$ART/05-dump-config.yml")
record "\$ dsh --profile $PROFILE --dump-config | grep commander   # exit=$DUMP_EXIT, rows=$COMMANDER_ROWS"
cat "$ART/06-dump-config-commander.txt" >> "$CMDS"
assert "dump-config exit" "0" "$DUMP_EXIT"
assert "dump-config has commander row" "1" "$COMMANDER_ROWS"

# ---- 4) 启动隔离 web Host ----
log "boot isolated web host"
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --port 0 --no-open > "$ART/07-boot.out" 2> "$ART/07-boot.err" &
BOOT_PID=$!
BASE=""
for _ in $(seq 1 160); do
  BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/07-boot.out" | head -1)
  [ -n "$BASE" ] && break
  sleep 0.25
done
if [ -z "$BASE" ]; then log "FAIL: host did not print URL"; head -20 "$ART/07-boot.err"; kill "$BOOT_PID" 2>/dev/null; exit 2; fi
TOKEN=$(sed -n 's#^dsh web: http://[^/]*/?token=\(.*\)$#\1#p' "$ART/07-boot.out" | head -1)
record "## boot $(date '+%Y-%m-%dT%H:%M:%S%z') BASE=$BASE token_len=${#TOKEN}"
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true)
  [ "$code" = "200" ] && break
  sleep 0.25
done

# 4a) host 行加载证据：/commander/health
HEALTH_CODE=$(curl -s -o "$ART/08-commander-health.json" -w '%{http_code}' "$BASE/commander/health")
record "\$ curl $BASE/commander/health   # http=$HEALTH_CODE"
assert "host half route /commander/health" "200" "$HEALTH_CODE"
HEALTH_OK=$(node -e "try{const j=require('$ART/08-commander-health.json');console.log(j.ok===true?'yes':'no')}catch{console.log('no')}")
assert "health payload ok:true" "yes" "$HEALTH_OK"
STATE_CODE=$(curl -s -o "$ART/14-commander-state.json" -w '%{http_code}' "$BASE/commander/state")
record "\$ curl $BASE/commander/state   # http=$STATE_CODE bytes=$(wc -c < "$ART/14-commander-state.json" | tr -d ' ')"
node -e "try{const j=require('$ART/14-commander-state.json');console.log('## /commander/state keys:',Object.keys(j).join(','))}catch(e){console.log('## /commander/state not JSON')}" >> "$CMDS" 2>&1
BOOT_ERR_BYTES=$(wc -c < "$ART/07-boot.err" | tr -d ' ')
record "## boot stderr bytes=$BOOT_ERR_BYTES"
assert "boot stderr empty (no failed entries)" "0" "$BOOT_ERR_BYTES"

# 4b) 页面（token fence：无 token 401 → 带 token 200）
NO_TOKEN_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
record "\$ curl $BASE/ (no token)   # http=$NO_TOKEN_CODE"
PAGE_CODE=$(curl -sL -c "$ART/.jar" -b "$ART/.jar" -o "$ART/09-page.html" -w '%{http_code}' "$BASE/?token=$TOKEN")
record "\$ curl -sL '$BASE/?token=***'   # http=$PAGE_CODE bytes=$(wc -c < "$ART/09-page.html" | tr -d ' ')"
assert "page without token is fenced (401)" "401" "$NO_TOKEN_CODE"
assert "page with token" "200" "$PAGE_CODE"

# 4c) boot graph 里的 commander 行（id/inject/immediately）
node - "$ART/09-page.html" "$ART/10-boot-entry-commander.json" <<'NODE' >> "$CMDS" 2>&1
const fs = require('node:fs')
const [pageFile, outFile] = process.argv.slice(2)
const html = fs.readFileSync(pageFile, 'utf8')
const m = html.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\});?<\/script>/s)
if (!m) { console.error('## ASSERT FAIL boot graph global not found'); process.exit(1) }
const boot = JSON.parse(m[1])
const row = (boot.entries || []).find((entry) => entry.id === 'dsh-commander')
const batch = (boot.batches || []).find((b) => (b.entries || []).includes('dsh-commander'))
const out = { release: boot.release, entry: row ?? null, batch: batch === undefined ? null : { phase: batch.phase, url: batch.url, rev: batch.rev } }
fs.writeFileSync(outFile, JSON.stringify(out, null, 2) + '\n')
console.log('## boot graph commander entry:', JSON.stringify(row))
if (row === null) { console.error('## ASSERT FAIL commander entry missing from boot graph'); process.exit(1) }
NODE
GRAPH_EXIT=$?
assert "boot graph has commander entry" "0" "$GRAPH_EXIT"
ENTRY_INJECT=$(node -e "const j=require('$ART/10-boot-entry-commander.json'); console.log((j.entry?.inject??[]).join('|'))")
ENTRY_IMMEDIATELY=$(node -e "const j=require('$ART/10-boot-entry-commander.json');console.log(j.entry?.immediately)")
record "## commander inject=$ENTRY_INJECT immediately=$ENTRY_IMMEDIATELY"
assert "commander inject (blueprint §2.1)" "@deepseek-ai/dsh-client-ui-layout|@deepseek-ai/dsh-client-ui-settings|@deepseek-ai/dsh-api-remotes" "$ENTRY_INJECT"

# 4d) Host 提供的 client bundle 头是官方 ModuleLoader 包裹
BUNDLE_URL=$(node -e "const j=require('$ART/10-boot-entry-commander.json'); console.log(j.entry?.url ?? '')")
BUNDLE_CODE=$(curl -s -b "$ART/.jar" -o "$ART/11-client-bundle.js" -w '%{http_code}' "$BASE/$BUNDLE_URL")
record "\$ curl '$BASE/$BUNDLE_URL'   # http=$BUNDLE_CODE bytes=$(wc -c < "$ART/11-client-bundle.js" | tr -d ' ')"
assert "served client bundle" "200" "$BUNDLE_CODE"
head -c 400 "$ART/11-client-bundle.js" > "$ART/11-client-bundle-head.txt"
tail -c 200 "$ART/11-client-bundle.js" > "$ART/11-client-bundle-tail.txt"
node "$REPO/tools/dev/verify-bundle.mjs" "$ART/11-client-bundle.js" dsh-commander > "$ART/12-verify-served-bundle.json" 2>&1
VERIFY_EXIT=$?
record "\$ node tools/dev/verify-bundle.mjs 11-client-bundle.js dsh-commander   # exit=$VERIFY_EXIT"
cat "$ART/12-verify-served-bundle.json" >> "$CMDS"
assert "served bundle is official ModuleLoader factory wrapper + react external" "0" "$VERIFY_EXIT"
node "$REPO/tools/dev/verify-bundle.mjs" "$REPO/packages/dsh-commander/lib/client.js" dsh-commander > "$ART/13-verify-local-bundle.json" 2>&1
LOCAL_VERIFY_EXIT=$?
record "\$ node tools/dev/verify-bundle.mjs packages/dsh-commander/lib/client.js   # exit=$LOCAL_VERIFY_EXIT"
assert "local lib/client.js official wrapper" "0" "$LOCAL_VERIFY_EXIT"

# ---- 5) 收尾：Host 退出 + live 后基线 ----
kill "$BOOT_PID" 2>/dev/null
wait "$BOOT_PID" 2>/dev/null
record "## host stopped (exit=$?)"
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-post.txt" >/dev/null 2>&1 || true
if diff <(grep -v '^#' "$ART/live-pre.txt" 2>/dev/null) <(grep -v '^#' "$ART/live-post.txt" 2>/dev/null) > "$ART/live-state-diff.txt" 2>&1; then
  record "## LIVE-STATE: identical except timestamp header"
else
  record "## LIVE-STATE: DIFF DETECTED (see live-state-diff.txt)"
fi

if [ "$FAILED" -eq 0 ]; then
  record "## RESULT: PASS"
  log "PASS (artifacts: $ART)"
  exit 0
else
  record "## RESULT: FAIL"
  log "FAIL (artifacts: $ART)"
  exit 1
fi
