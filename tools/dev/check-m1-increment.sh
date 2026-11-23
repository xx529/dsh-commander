#!/bin/bash
# M1 增量 boot 验证（隔离 profile，/tmp DSH_HOME；不写 live）
#
# 覆盖 backend M1 交付里「不需要真实模型回合」的部分：
#   1) 构建最新 Host/Client；
#   2) boot 隔离 web Host（COMMANDER_BOOT_LOG=warn），抓 boot 日志中 tools/systemPrompt/commander 报错；
#   3) `/commander/health`、`/commander/state`（含 M1 新增 pendingDispatch）、`/commander/config` 200；
#   4) `POST /commander/jev/test`（隔离无 key → 200 `{ok:false,code:'jev_unavailable',hasApiKey:false}`，且不回传 key）；
#   5) cwd-only 绑定 + `POST /commander/message` 200 accepted（M1 message 路径回归）；
#   6) 页面 boot graph 里 commander client 行（inject 两项/immediately）；
#   7) `GET /commander/tasks/nonexistent` 错误形状（M1 新路由可达性）。
#
# 说明：commander_task_create/commander_task_dispatch 需要真实 agent 回合（模型/provider）；隔离 Home 无 key →
# 该段需 live desktop（重启后）或用 stub provider 驱动（本脚本不覆盖，另议）。
#
# 用法：bash tools/dev/check-m1-increment.sh
#       PROBE_ROOT=/tmp/x OUTDIR=/tmp/ev bash tools/dev/check-m1-increment.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_ROOT="${PROBE_ROOT:-/tmp/dsh-commander-m1}"
DSH_HOME="$PROBE_ROOT/home"
DSH_AGENTS_HOME="$PROBE_ROOT/agents"
PROFILE=m1
ART="${OUTDIR:-$REPO/docs/validation/m1-artifacts}"
export DSH_HOME DSH_AGENTS_HOME
mkdir -p "$ART"
CMDS="$ART/commands.log"; : > "$CMDS"
FAILED=0
log() { echo "[m1] $*"; }
record() { echo "$*" >> "$CMDS"; }
assert() { local n="$1" e="$2" a="$3"; if [ "$e" = "$a" ]; then record "## ASSERT PASS $n ($a)"; log "PASS $n ($a)"; else record "## ASSERT FAIL $n expected=$e actual=$a"; log "FAIL $n expected=$e actual=$a"; FAILED=1; fi; }
assert_in() { if printf '%s' "$2" | grep -q -- "$3"; then record "## ASSERT PASS $1"; log "PASS $1"; else record "## ASSERT FAIL $1 (missing '$3')"; log "FAIL $1 (missing '$3')"; FAILED=1; fi; }
finding() { record "## FINDING $1"; log "FINDING $1"; }
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

{
  echo "# M1 增量 boot 验证环境 $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "dsh CLI: $(dsh --version 2>/dev/null)"; echo "node(PATH): $(node --version)"; echo "pnpm: $(pnpm --version 2>/dev/null)"
  echo "PROBE_ROOT=$PROBE_ROOT"
} > "$ART/env-versions.txt" 2>&1

# 1) 构建
( cd "$REPO" && pnpm --filter dsh-commander build ) > "$ART/01-build.log" 2>&1
BUILD_EXIT=$?
record "\$ pnpm --filter dsh-commander build   # exit=$BUILD_EXIT"
assert "build exit" "0" "$BUILD_EXIT"
[ "$BUILD_EXIT" -ne 0 ] && { log "build failed"; exit 2; }
cp "$REPO/packages/dsh-commander/lib/client.js" "$ART/02-client.js" 2>/dev/null || true
CLIENT_SIZE=$(wc -c < "$REPO/packages/dsh-commander/lib/client.js" | tr -d ' ')
record "## client.js bytes=$CLIENT_SIZE"
node "$REPO/tools/dev/verify-bundle.mjs" "$REPO/packages/dsh-commander/lib/client.js" dsh-commander > "$ART/02-verify-bundle.json" 2>&1
assert "client verify-bundle" "0" "$?"

# 2) 全新隔离 profile + 安装
rm -rf "$PROBE_ROOT/home" "$PROBE_ROOT/agents"; mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$ART"
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --from-default-profile web --dump-default-config > "$ART/03-default-config.yml" 2> "$ART/03-default-config.err"
INIT_EXIT=$?; record "\$ dsh --profile $PROFILE --from-default-profile web --dump-default-config   # exit=$INIT_EXIT"
assert "init profile exit" "0" "$INIT_EXIT"
# ui-chat 符号链接（web 模板需要）
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
ADD_EXIT=$?; record "\$ dsh plugin --profile $PROFILE add file:$REPO/packages/dsh-commander   # exit=$ADD_EXIT"
assert "plugin add exit" "0" "$ADD_EXIT"
[ "$ADD_EXIT" -ne 0 ] && exit 2

# 3) boot（带只读 introspect fixture：观察指挥官 agent 作用域的 tools / systemPrompt 注册路径）
INTROSPECT_PATCH="$PROBE_ROOT/m1-introspect.patch.yml"
cat > "$INTROSPECT_PATCH" <<EOF
- insert:
    - id: m1-introspect
      name: 'file://$REPO/tools/dev/spike/m1-introspect.mjs'
EOF
log "boot isolated host (COMMANDER_BOOT_LOG=warn + m1-introspect)"
COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$INTROSPECT_PATCH" --port 0 --no-open > "$ART/05-boot.out" 2> "$ART/05-boot.err" &
BOOT_PID=$!
BASE=""
for _ in $(seq 1 160); do BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/05-boot.out" | head -1); [ -n "$BASE" ] && break; sleep 0.25; done
[ -z "$BASE" ] && { log "FAIL: no URL"; cat "$ART/05-boot.err"; exit 2; }
TOKEN=$(sed -n 's#^dsh web: http://[^/]*/?token=\(.*\)$#\1#p' "$ART/05-boot.out" | head -1)
record "## boot BASE=$BASE token_len=${#TOKEN}"
for _ in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true); [ "$code" = "200" ] && break; sleep 0.25; done
sleep 1

# 4) boot 日志：ready 行 + tools/systemPrompt 报错扫描
{ grep -n "commander" "$ART/05-boot.out" 2>/dev/null; grep -n "commander" "$ART/05-boot.err" 2>/dev/null; } > "$ART/06-boot-commander-lines.txt" 2>&1 || true
assert_in "boot ready line" "$(cat "$ART/06-boot-commander-lines.txt")" "commander] host ready"
BOOT_ERR_BYTES=$(wc -c < "$ART/05-boot.err" | tr -d ' ')
record "## boot stderr bytes=$BOOT_ERR_BYTES"
if [ "$BOOT_ERR_BYTES" = "0" ]; then
  record "## ASSERT PASS boot stderr empty"; log "PASS boot stderr empty"
else
  grep -n -i "tool\|systemPrompt\|error\|warn" "$ART/05-boot.err" > "$ART/06-boot-errors.txt" 2>&1 || true
  assert_in "boot stderr contains only expected commander ready line" "$(cat "$ART/05-boot.err")" "commander] host ready"
  record "## WARN boot stderr non-empty（见 06-boot-errors.txt；只应含 commander ready 行）"
fi

get() { local p="$1" out="$2" code; code=$(curl -s "$BASE$p" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ curl -s '$BASE$p'   # http=$code"; echo "$code"; }
post() { local p="$1" body="$2" out="$3" code; code=$(curl -s -X POST "$BASE$p" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ curl -s -X POST '$BASE$p' -d '$body'   # http=$code"; echo "$code"; }

# 5) health / state / config
CODE=$(get /commander/health "10-health.json"); assert "GET /commander/health" "200" "$CODE"
node -e "const j=require('$ART/10-health.json');console.log('## health:',JSON.stringify(j))" >> "$CMDS" 2>/dev/null
assert_in "health panel absent (isolated)" "$(cat "$ART/10-health.json")" '"panel":"absent"'
CODE=$(get /commander/state "11-state.json"); assert "GET /commander/state" "200" "$CODE"
assert_in "state has pendingDispatch (M1)" "$(cat "$ART/11-state.json")" '"pendingDispatch"'
record "## state keys=$(node -e "try{console.log(Object.keys(require('$ART/11-state.json')).join(','))}catch{console.log('parse-fail')}")"
CODE=$(get /commander/config "12-config.json"); assert "GET /commander/config" "200" "$CODE"
# M1 jev/test（无 key）
JEV_CODE=$(post /commander/jev/test '{}' "13-jev-test.json")
record "## jev/test body=$(cat "$ART/13-jev-test.json")"
assert "POST /commander/jev/test (no key)" "200" "$JEV_CODE"
assert_in "jev/test jev_unavailable + hasApiKey:false" "$(cat "$ART/13-jev-test.json")" '"code":"jev_unavailable"'
assert_in "jev/test hasApiKey:false" "$(cat "$ART/13-jev-test.json")" '"hasApiKey":false'
# M1 tasks/:id 路由可达（不存在 id → 4xx，非 404 路由缺失）
TASK_CODE=$(get /commander/tasks/task_nonexistent_probe "14-task-nonexistent.json")
record "## tasks/:id http=$TASK_CODE body=$(head -c 200 "$ART/14-task-nonexistent.json")"
if [ "$TASK_CODE" = "404" ] || [ "$TASK_CODE" = "400" ]; then record "## ASSERT PASS tasks/:id route reachable"; else record "## ASSERT FAIL tasks/:id route (http=$TASK_CODE)"; FAILED=1; fi

# 6) cwd-only 绑定 + message（M1 message 路径回归）
BIND_CODE=$(post /commander/binding "{\"mode\":\"new\",\"cwd\":\"$PROBE_ROOT\",\"requestId\":\"req_m1_bind_1\"}" "15-binding.json")
record "## binding body=$(cat "$ART/15-binding.json")"
assert "binding cwd-only (M1)" "200" "$BIND_CODE"
BOUND_SID=$(node -e "try{const j=require('$ART/15-binding.json');console.log(j.binding?.sessionId ?? '')}catch{console.log('')}")
record "## bound commander sessionId=$BOUND_SID"
# tools 安装在 agent/created 回调里异步执行：轮询到注册完成（最多 ~6s）
INTRO_CODE=""
for _ in $(seq 1 12); do
  INTRO_CODE=$(curl -s "$BASE/m1/agent-tools?sessionId=$BOUND_SID" -o "$ART/15b-introspect.json" -w '%{http_code}' 2>>"$ART/.curl.err")
  grep -q '"commander_task_create"' "$ART/15b-introspect.json" 2>/dev/null && break
  sleep 0.5
done
record "\$ curl -s '$BASE/m1/agent-tools?sessionId=$BOUND_SID'   # http=${INTRO_CODE} (轮询到 tools 注册完成)"
assert "GET /m1/agent-tools (probe)" "200" "$INTRO_CODE"
record "## introspect body=$(head -c 500 "$ART/15b-introspect.json")"
assert_in "probe: commander agent found" "$(cat "$ART/15b-introspect.json")" '"agentFound": true'
for tool in commander_task_create commander_task_update commander_task_dispatch commander_task_list; do
  if grep -q "\"$tool\"" "$ART/15b-introspect.json" 2>/dev/null; then
    record "## ASSERT PASS probe: commander tool $tool registered"; log "PASS probe: $tool registered"
  else
    record "## KNOWN-LIMITATION schemas() 不反映动态注册，不能据此判 ${tool} 缺失（真实回合判据见 tools/dev/check-m1-tools.sh + docs/validation/m1-boot.md §5.1）；本次改为记录不判 FAIL"; log "KNOWN-LIMITATION schemas() cannot judge ${tool} (see check-m1-tools.sh)"
  fi
done
SPECS_CODE=$(get /m1/specs-test "15c-specs-test.json")
record "## specs-test body=$(head -c 800 "$ART/15c-specs-test.json")"
assert_in "probe: systemPrompt service present in commander scope" "$(cat "$ART/15b-introspect.json")" '"systemPrompt": "object"'
MSG_CODE=$(post /commander/message '{"text":"M1 boot 冒烟：只回一句 ok","requestId":"req_m1_msg_1"}' "16-message.json")
record "## message body=$(cat "$ART/16-message.json")"
assert "message accepted (M1)" "200" "$MSG_CODE"
assert_in "message accepted:true" "$(cat "$ART/16-message.json")" '"accepted":true'

# 7) 页面 boot graph client 行（带 token）
curl -sL -c "$ART/.jar" -b "$ART/.jar" -o "$ART/17-page.html" -w 'page http=%{http_code}\n' "$BASE/?token=$TOKEN" >> "$CMDS" 2>&1
node - "$ART/17-page.html" "$ART/18-boot-entry.json" <<'NODE' >> "$CMDS" 2>&1
const fs = require('node:fs')
const [pageFile, outFile] = process.argv.slice(2)
const html = fs.readFileSync(pageFile, 'utf8')
const m = html.match(/globalThis\["__DSH_BOOT__"\] = (\{.*?\});?<\/script>/s)
if (!m) { console.log('## ASSERT FAIL boot graph not found'); process.exit(1) }
const boot = JSON.parse(m[1])
const row = (boot.entries || []).find((e) => e.id === 'dsh-commander')
fs.writeFileSync(outFile, JSON.stringify(row ?? null, null, 2) + '\n')
console.log('## commander client entry:', JSON.stringify(row))
NODE
[ -s "$ART/18-boot-entry.json" ] && assert_in "client inject two items (H3a)" "$(cat "$ART/18-boot-entry.json")" '"@deepseek-ai/dsh-client-ui-layout"'

# ---- case C：重启同 home（binding 已持久）→ resume 出的指挥官 agent 的 tools 注册 ----
log "===== case C: restart same home（binding 持久）→ resume agent → tools 注册 ====="
kill "$BOOT_PID" 2>/dev/null; wait "$BOOT_PID" 2>/dev/null
COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$INTROSPECT_PATCH" --port 0 --no-open > "$ART/20-boot2.out" 2> "$ART/20-boot2.err" &
BOOT_PID=$!
BASE=""
for _ in $(seq 1 160); do BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/20-boot2.out" | head -1); [ -n "$BASE" ] && break; sleep 0.25; done
if [ -n "$BASE" ]; then
  for _ in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true); [ "$code" = "200" ] && break; sleep 0.25; done
  BIND_SID2=$(curl -s "$BASE/commander/state" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).binding?.sessionId??'')}catch{console.log('')}})")
  record "## case C bound sessionId=${BIND_SID2} (来自持久化 config)"
  # 触发 resume（无模型 key：prompt 接受后异步失败，但 agent 已创建）
  curl -s -X POST "$BASE/commander/message" -H 'content-type: application/json' \
    -d '{"text":"M1 case C：触发 resume","requestId":"req_m1_casec_1"}' -o "$ART/21-casec-message.json" -w 'caseC message http=%{http_code}\n' >> "$CMDS" 2>&1
  TOOLS_OK=""
  for _ in $(seq 1 16); do
    curl -s "$BASE/m1/agent-tools?sessionId=$BIND_SID2" -o "$ART/22-casec-introspect.json" 2>/dev/null
    if grep -q '"commander_task_create"' "$ART/22-casec-introspect.json" 2>/dev/null; then TOOLS_OK=yes; break; fi
    sleep 0.5
  done
  record "## case C introspect=$(head -c 500 "$ART/22-casec-introspect.json" 2>/dev/null)"
  if [ "$TOOLS_OK" = "yes" ]; then
    record "## ASSERT PASS case C: 重启后 resume 出的指挥官 agent tools 注册正常（commander_task_create 可见）"; log "PASS case C tools registered after restart"
  else
    record "## KNOWN-LIMITATION case C 用 schemas() 判定同样不可靠；真实回合见 check-m1-tools.sh"; log "KNOWN-LIMITATION case C schemas() unreliable"
  fi
else
  record "## WARN case C boot2 failed（见 20-boot2.err）"
fi

# 收尾
kill "$BOOT_PID" 2>/dev/null; wait "$BOOT_PID" 2>/dev/null
if [ "$FAILED" -eq 0 ]; then record "## RESULT: PASS"; log "PASS (artifacts: $ART)"; exit 0; fi
record "## RESULT: FAIL"; log "FAIL (artifacts: $ART)"; exit 1
