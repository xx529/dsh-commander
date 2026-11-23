#!/bin/bash
# task-65 隔离验证：sessionQuery 形状（title/createdAt/lastActiveAt）+ 冷会话 bindSelect + 404/409
#
# 用法：bash tools/dev/check-binding-select.sh
#   PROBE_ROOT=/tmp/x OUTDIR=/tmp/ev bash tools/dev/check-binding-select.sh
# 流程：boot1 建两个工作区 + 建会话并产标题快照 → 重启同 home（会话变冷）→ boot2 验证。
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_ROOT="${PROBE_ROOT:-/tmp/dsh-commander-bindsel}"
DSH_HOME="$PROBE_ROOT/home"; DSH_AGENTS_HOME="$PROBE_ROOT/agents"
PROFILE=bindsel
ART="${OUTDIR:-$REPO/docs/validation/bindsel-artifacts}"
export DSH_HOME DSH_AGENTS_HOME
mkdir -p "$ART" "$PROBE_ROOT/ws" "$PROBE_ROOT/ws2"
CMDS="$ART/commands.log"; : > "$CMDS"
FAILED=0
log() { echo "[bindsel] $*"; }
record() { echo "$*" >> "$CMDS"; }
assert() { local n="$1" e="$2" a="$3"; if [ "$e" = "$a" ]; then record "## ASSERT PASS $n ($a)"; log "PASS $n ($a)"; else record "## ASSERT FAIL $n expected=$e actual=$a"; log "FAIL $n expected=$e actual=$a"; FAILED=1; fi; }
jassert() { local n="$1" f="$2" expr="$3"; local got; got=$(node -e "const fs=require('node:fs');try{const j=JSON.parse(fs.readFileSync('$f','utf8'));console.log(String($expr))}catch(e){console.log('ERR')}" 2>/dev/null); assert "$n" "true" "$got"; }
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

# 1) build
( cd "$REPO" && pnpm --filter dsh-commander build ) > "$ART/01-build.log" 2>&1
assert "build exit" "0" "$?"
node "$REPO/tools/dev/verify-bundle.mjs" "$REPO/packages/dsh-commander/lib/client.js" dsh-commander > "$ART/02-verify-bundle.json" 2>&1
assert "verify-bundle exit" "0" "$?"
record "## client sha=$(shasum -a 256 "$REPO/packages/dsh-commander/lib/client.js" | cut -d' ' -f1)"

# 2) fresh profile + install + fixtures（两个工作区）
rm -rf "$DSH_HOME" "$DSH_AGENTS_HOME"; mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME"
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --from-default-profile web --dump-default-config > "$ART/03-default-config.yml" 2> "$ART/03-default-config.err"
DSH_BIN="$(command -v dsh || true)"; CLI_DIR=""
if [ -n "$DSH_BIN" ] && [ -f "$DSH_BIN" ]; then
  CLI_BINJS="$(sed -n 's#.*"\([^"]*lib/node_modules/@deepseek-ai/dsh/lib/bin.js\)".*#\1#p' "$DSH_BIN" | head -1)"; CLI_BINJS="${CLI_BINJS//\$HOME/$HOME}"
  [ -f "$CLI_BINJS" ] && CLI_DIR="$(dirname "$(dirname "$CLI_BINJS")")"
fi
[ -z "$CLI_DIR" ] && CLI_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh 2>/dev/null | tail -1)"
if [ -n "$CLI_DIR" ] && [ -d "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" ]; then
  mkdir -p "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai"
  ln -sfn "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai/dsh-client-ui-chat"
fi
env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX \
  npm_config_registry="${npm_config_registry:-https://mirrors.cloud.tencent.com/npm/}" npm_config_store_dir="$PROBE_ROOT/.pnpm-store" \
  dsh plugin --profile "$PROFILE" add "file:$REPO/packages/dsh-commander" > "$ART/04-plugin-add.log" 2>&1
assert "plugin add exit" "0" "$?"

PATCH="$PROBE_ROOT/bindsel.patch.yml"
cat > "$PATCH" <<EOF
- insert:
    - id: m1-tools-driver
      name: 'file://$REPO/tools/dev/spike/m1-tools-driver.mjs'
    - id: m0-workspace-fixture
      name: 'file://$REPO/tools/dev/spike/m0-workspace-fixture.mjs'
      config:
        path: $PROBE_ROOT/ws
    - id: m0-workspace-fixture-2
      name: 'file://$REPO/tools/dev/spike/m0-workspace-fixture.mjs'
      config:
        path: $PROBE_ROOT/ws2
EOF
boot() { # $1=boot tag ; sets BASE
  COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$PATCH" --port 0 --no-open > "$ART/$1.out" 2> "$ART/$1.err" &
  BOOT_PID=$!
  BASE=""
  for _ in $(seq 1 160); do BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/$1.out" | head -1); [ -n "$BASE" ] && break; sleep 0.25; done
  [ -z "$BASE" ] && { log "FAIL boot $1"; cat "$ART/$1.err"; exit 2; }
  for _ in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true); [ "$code" = "200" ] && break; sleep 0.25; done
  for _ in $(seq 1 80); do WS_N=$(grep -c 'workspace created\|workspace exists' "$ART/$1.out" 2>/dev/null | head -1); [ "${WS_N:-0}" -ge 2 ] && break; sleep 0.25; done
  sleep 0.5
}
get() { local p="$1" out="$2" code; code=$(curl -s "$BASE$p" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ GET '$BASE$p' # http=$code"; echo "$code"; }
post() { local p="$1" body="$2" out="$3" code; code=$(curl -s -X POST "$BASE$p" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ POST '$BASE$p' -d '$body' # http=$code"; echo "$code"; }

# 3) boot1：取两个 workspace；建 ws1 会话 + 产标题快照（一次 stub 回合）
boot 05-boot1
for _ in $(seq 1 40); do sleep 0.25; code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true); [ "$code" = "200" ] && break; done
sleep 2.0
CODE=$(get /commander/state 06-state-boot1.json); assert "boot1 GET state" "200" "$CODE"
WS1=$(node -e "try{const j=require('$ART/06-state-boot1.json');const ws=j.workspaces||[];const a=ws.find(w=>String(w.path).endsWith('/ws'));console.log(a?.id??ws[0]?.id??'')}catch(e){console.log('')}" 2>/dev/null)
WS2=$(node -e "try{const j=require('$ART/06-state-boot1.json');const ws=j.workspaces||[];const b=ws.find(w=>String(w.path).endsWith('/ws2'));console.log(b?.id??'')}catch(e){console.log('')}" 2>/dev/null)
WS1_PATH=$(node -e "try{const j=require('$ART/06-state-boot1.json');const w=(j.workspaces||[]).find(x=>x.id==='$WS1');console.log(w?.path??'')}catch(e){console.log('')}" 2>/dev/null)
WS2_PATH=$(node -e "try{const j=require('$ART/06-state-boot1.json');const w=(j.workspaces||[]).find(x=>x.id==='$WS2');console.log(w?.path??'')}catch(e){console.log('')}" 2>/dev/null)
record "## ws1=$WS1 ($WS1_PATH) ws2=$WS2 ($WS2_PATH)"
assert "两个 fixture 工作区都注册" "2" "$([ -n "$WS1" ] && [ -n "$WS2" ] && echo 2 || echo 1)"
CODE=$(get "/m1e2e/create-session?cwd=$WS1_PATH" 07-create-cold.json); assert "boot1 create ws1 session" "200" "$CODE"
COLD=$(node -e "try{console.log(require('$ART/07-create-cold.json').created?.sessionId??'')}catch(e){console.log('')}")
record "## cold session=$COLD"
CODE=$(get "/m1e2e/prepare?sessionId=$COLD" 08-prepare-cold.json); assert "prepare stub for cold session" "200" "$CODE"
CODE=$(get "/m1e2e/drive?sessionId=$COLD&text=PROBE_M1_TASK" 09-drive-cold.json); assert "drive cold session（产标题快照）" "200" "$CODE"
CODE=$(get "/m1e2e/events?sessionId=$COLD" 09b-events-cold.json)
sleep 1.0
kill "$BOOT_PID" 2>/dev/null; wait "$BOOT_PID" 2>/dev/null

# 4) boot2：同 home 重启 → 会话变冷；验证 sessions 形状 + bindSelect
boot 10-boot2
sleep 1.0
CODE=$(get "/commander/sessions?workspaceId=$WS1" 11-sessions.json); assert "boot2 GET /commander/sessions" "200" "$CODE"
jassert "sessions 含冷会话" "$ART/11-sessions.json" "(j.sessions||[]).some(r=>r.sessionId==='$COLD')"
jassert "sessions title 非空（readTitleSnapshots）" "$ART/11-sessions.json" "(()=>{const r=(j.sessions||[]).find(x=>x.sessionId==='$COLD');return r&&typeof r.title==='string'&&r.title.length>0&&r.title!==r.sessionId})()"
jassert "sessions createdAt 数字>0" "$ART/11-sessions.json" "(()=>{const r=(j.sessions||[]).find(x=>x.sessionId==='$COLD');return r&&typeof r.createdAt==='number'&&r.createdAt>0})()"
jassert "sessions lastActiveAt 字段存在（数字）" "$ART/11-sessions.json" "(()=>{const r=(j.sessions||[]).find(x=>x.sessionId==='$COLD');return r&&typeof r.lastActiveAt==='number'})()"
record "## sessions body=$(head -c 700 "$ART/11-sessions.json")"
# 4a) 未知 id → 404 + 可用会话数
CODE=$(post /commander/binding "{\"mode\":\"select\",\"sessionId\":\"session_unknown_probe_65\"}" 12-bind-unknown.json); assert "未知 session bindSelect → 404" "404" "$CODE"
jassert "404 message 含可用会话数" "$ART/12-bind-unknown.json" "/可用会话\\s*\\d+\\s*个/.test(String(j.message||''))"
# 4b) 跨工作区 → 409 workspace_conflict（在 ws2 建会话，用 ws1 绑定）
CODE=$(get "/m1e2e/create-session?cwd=$WS2_PATH" 13-create-ws2.json); assert "boot2 create ws2 session" "200" "$CODE"
WS2_SID=$(node -e "try{console.log(require('$ART/13-create-ws2.json').created?.sessionId??'')}catch(e){console.log('')}")
CODE=$(post /commander/binding "{\"mode\":\"select\",\"sessionId\":\"$WS2_SID\",\"workspaceId\":\"$WS1\"}" 14-bind-cross.json); assert "跨工作区 bindSelect → 409" "409" "$CODE"
jassert "409 code=workspace_conflict" "$ART/14-bind-cross.json" "j.code==='workspace_conflict'"
# 4c) 冷会话 → 200 bound（不再 not_found）
CODE=$(post /commander/binding "{\"mode\":\"select\",\"sessionId\":\"$COLD\"}" 15-bind-cold.json); assert "冷会话 bindSelect（自动推断 workspace）→ 200" "200" "$CODE"
jassert "冷绑定 sessionId 正确 + workspaceId 推断=ws1" "$ART/15-bind-cold.json" "j.ok===true && j.binding?.sessionId==='$COLD' && j.binding?.workspaceId==='$WS1'"
CODE=$(get /commander/state 16-state-bound.json)
jassert "state.binding 已持久冷会话" "$ART/16-state-bound.json" "j.binding?.sessionId==='$COLD'"
# 4d) 已绑定后再选另一会话（跨工作区显式 workspaceId=ws2 的 ws2 会话）→ 200（切换绑定）
CODE=$(post /commander/binding "{\"mode\":\"select\",\"sessionId\":\"$WS2_SID\",\"workspaceId\":\"$WS2\"}" 17-bind-switch.json); assert "已绑定后切换到 ws2 会话 → 200" "200" "$CODE"
jassert "切换后 binding=ws2 会话" "$ART/17-bind-switch.json" "j.binding?.sessionId==='$WS2_SID' && j.binding?.workspaceId==='$WS2'"

kill "$BOOT_PID" 2>/dev/null; wait "$BOOT_PID" 2>/dev/null
if [ "$FAILED" -eq 0 ]; then record "## RESULT: PASS"; log "PASS (artifacts: $ART)"; exit 0; fi
record "## RESULT: FAIL"; log "FAIL (artifacts: $ART)"; exit 1
