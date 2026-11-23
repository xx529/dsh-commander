#!/bin/bash
# M1R 隔离验证：build/verify + `GET /commander/sessions?workspaceId` 形状 + attach 确认派发
#
# 用法：bash tools/dev/check-m1r.sh
#   PROBE_ROOT=/tmp/x OUTDIR=/tmp/ev bash tools/dev/check-m1r.sh
# 退出码：0 = 全部硬断言 PASS；非 0 = 失败（详见 artifacts/commands.log）。
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_ROOT="${PROBE_ROOT:-/tmp/dsh-commander-m1r}"
DSH_HOME="$PROBE_ROOT/home"; DSH_AGENTS_HOME="$PROBE_ROOT/agents"
PROFILE=m1r
ART="${OUTDIR:-$REPO/docs/validation/m1r-artifacts}"
export DSH_HOME DSH_AGENTS_HOME
mkdir -p "$ART" "$PROBE_ROOT/ws"
CMDS="$ART/commands.log"; : > "$CMDS"
FAILED=0
log() { echo "[m1r] $*"; }
record() { echo "$*" >> "$CMDS"; }
assert() { local n="$1" e="$2" a="$3"; if [ "$e" = "$a" ]; then record "## ASSERT PASS $n ($a)"; log "PASS $n ($a)"; else record "## ASSERT FAIL $n expected=$e actual=$a"; log "FAIL $n expected=$e actual=$a"; FAILED=1; fi; }
assert_in() { if printf '%s' "$2" | grep -q -- "$3"; then record "## ASSERT PASS $1"; log "PASS $1"; else record "## ASSERT FAIL $1 (missing '$3')"; log "FAIL $1 (missing '$3')"; FAILED=1; fi; }
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

{
  echo "# M1R 隔离验证环境 $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "dsh CLI: $(dsh --version 2>/dev/null)"; echo "node: $(node --version)"; echo "PROBE_ROOT=$PROBE_ROOT"
} > "$ART/env-versions.txt" 2>&1

# 1) build + verify-bundle
( cd "$REPO" && pnpm --filter dsh-commander build ) > "$ART/01-build.log" 2>&1
BUILD=$?; record "\$ pnpm --filter dsh-commander build # exit=$BUILD"; assert "build exit" "0" "$BUILD"
[ "$BUILD" -ne 0 ] && exit 2
node "$REPO/tools/dev/verify-bundle.mjs" "$REPO/packages/dsh-commander/lib/client.js" dsh-commander > "$ART/02-verify-bundle.json" 2>&1
VB=$?; record "\$ verify-bundle # exit=$VB"; assert "verify-bundle exit" "0" "$VB"
record "## client.js sha256=$(shasum -a 256 "$REPO/packages/dsh-commander/lib/client.js" | cut -d' ' -f1) size=$(wc -c < "$REPO/packages/dsh-commander/lib/client.js" | tr -d ' ')"

# 2) fresh isolated profile + install
rm -rf "$DSH_HOME" "$DSH_AGENTS_HOME"; mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME"
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --from-default-profile web --dump-default-config > "$ART/03-default-config.yml" 2> "$ART/03-default-config.err"
record "\$ dsh --profile $PROFILE --from-default-profile web --dump-default-config # exit=$?"
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
ADD=$?; record "\$ dsh plugin add # exit=$ADD"; assert "plugin add exit" "0" "$ADD"; [ "$ADD" -ne 0 ] && exit 2

# 3) boot（stub driver + workspace fixture）
PATCH="$PROBE_ROOT/m1r.patch.yml"
cat > "$PATCH" <<EOF
- insert:
    - id: m1-tools-driver
      name: 'file://$REPO/tools/dev/spike/m1-tools-driver.mjs'
    - id: m0-workspace-fixture
      name: 'file://$REPO/tools/dev/spike/m0-workspace-fixture.mjs'
      config:
        path: $PROBE_ROOT/ws
EOF
COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$PATCH" --port 0 --no-open > "$ART/05-boot.out" 2> "$ART/05-boot.err" &
BOOT_PID=$!
BASE=""
for _ in $(seq 1 160); do BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/05-boot.out" | head -1); [ -n "$BASE" ] && break; sleep 0.25; done
[ -z "$BASE" ] && { log "FAIL boot"; cat "$ART/05-boot.err"; exit 2; }
record "## boot BASE=$BASE"
for _ in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true); [ "$code" = "200" ] && break; sleep 0.25; done
for _ in $(seq 1 60); do grep -q "workspace created\|workspace exists" "$ART/05-boot.out" 2>/dev/null && break; sleep 0.25; done
sleep 0.5
assert_in "boot stderr only commander ready" "$(cat "$ART/05-boot.err")" "commander] host ready"

get() { local p="$1" out="$2" code; code=$(curl -s "$BASE$p" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ curl -s '$BASE$p' # http=$code"; echo "$code"; }
post() { local p="$1" body="$2" out="$3" code; code=$(curl -s -X POST "$BASE$p" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ curl -s -X POST '$BASE$p' -d '$body' # http=$code"; echo "$code"; }
put() { local p="$1" body="$2" out="$3" code; code=$(curl -s -X PUT "$BASE$p" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ curl -s -X PUT '$BASE$p' -d '$body' # http=$code"; echo "$code"; }

# 4) fixture workspace + PUT workspaces(allowed)
CODE=$(get /commander/state 10-state-initial.json); assert "GET /commander/state" "200" "$CODE"
WS_ID=$(node -e "try{console.log(require('$ART/10-state-initial.json').workspaces?.[0]?.id??'')}catch(e){console.log('')}")
record "## fixture workspace id=$WS_ID"
assert "fixture workspace registered" "1" "$([ -n "$WS_ID" ] && echo 1 || echo 0)"
CODE=$(put /commander/workspaces "{\"workspaces\":[{\"id\":\"$WS_ID\",\"allowed\":true,\"summary\":\"m1r probe workspace\",\"policy\":\"inherit\"}]}" 11-put-workspaces.json)
assert "PUT /commander/workspaces" "200" "$CODE"

# 5) GET /commander/sessions?workspaceId 形状（先创建一个工作会话）
WS_PATH=$(node -e "try{console.log(require('$ART/10-state-initial.json').workspaces?.[0]?.path??'')}catch(e){console.log('')}")
record "## workspace canonical path=$WS_PATH"
CODE=$(get "/m1e2e/create-session?cwd=$WS_PATH" 12-create-work-session.json)
assert "create work session" "200" "$CODE"
SID_WORK=$(node -e "try{console.log(require('$ART/12-create-work-session.json').created?.sessionId??'')}catch(e){console.log('')}")
record "## work sessionId=$SID_WORK"
assert "work session created" "1" "$([ -n "$SID_WORK" ] && echo 1 || echo 0)"
CODE=$(get "/commander/sessions?workspaceId=$WS_ID" 13-sessions.json)
assert "GET /commander/sessions" "200" "$CODE"
# 轮询等待 sessions 列出新会话（registry attach / query 索引可能滞后）
for _ in $(seq 1 10); do
  curl -s "$BASE/commander/sessions?workspaceId=$WS_ID" -o "$ART/13-sessions.json" 2>/dev/null
  node -e "const j=require('$ART/13-sessions.json');process.exit((j.sessions||[]).some(r=>r.sessionId==='$SID_WORK')?0:1)" 2>/dev/null && break
  sleep 0.3
done
node - "$ART/13-sessions.json" "$WS_ID" "$SID_WORK" <<'NODE' > "$ART/13-sessions-check.txt" 2>&1
const fs = require('node:fs')
const [file, wsId, sid] = process.argv.slice(2)
const body = JSON.parse(fs.readFileSync(file, 'utf8'))
const row = Array.isArray(body.sessions) ? body.sessions.find((item) => item.sessionId === sid) : undefined
const checks = {
  ok: body.ok === true,
  workspaceId: body.workspaceId === wsId,
  workspaceName: typeof body.workspaceName === 'string',
  sessionsArray: Array.isArray(body.sessions),
  truncatedBool: typeof body.truncated === 'boolean',
  revNumber: typeof body.rev === 'number',
  includesCreated: row !== undefined,
  rowShape: row !== undefined && typeof row.title === 'string' && typeof row.lastActiveAt === 'number' && row.archived === false,
}
console.log(JSON.stringify(checks))
process.exit(Object.values(checks).every(Boolean) ? 0 : 1)
NODE
SESSIONS_OK=$?
record "## sessions shape: $(cat "$ART/13-sessions-check.txt")"
assert "GET /commander/sessions 形状 + 含新建会话 + row 字段" "0" "$SESSIONS_OK"
record "## sessions body=$(head -c 600 "$ART/13-sessions.json")"
# 负路径：缺 workspaceId / 未知 workspace / 非法 limit
CODE=$(get "/commander/sessions" 14-sessions-missing-ws.json); assert "sessions missing workspaceId → 400" "400" "$CODE"
assert_in "sessions missing workspaceId error code" "$(cat "$ART/14-sessions-missing-ws.json")" 'invalid_request'
CODE=$(get "/commander/sessions?workspaceId=ws_unknown_probe" 15-sessions-unknown-ws.json); assert "sessions unknown workspace → 404" "404" "$CODE"
assert_in "sessions unknown workspace error code" "$(cat "$ART/15-sessions-unknown-ws.json")" 'not_found'
CODE=$(get "/commander/sessions?workspaceId=$WS_ID&limit=0" 16-sessions-bad-limit.json); assert "sessions limit=0 → 400" "400" "$CODE"

# 6) attach 确认派发：bind commander + stub model + 先 commander_task_create
CODE=$(post /commander/binding "{\"mode\":\"new\",\"workspaceId\":\"$WS_ID\",\"requestId\":\"req_m1r_bind_1\"}" 20-binding.json)
assert "binding (workspaceId)" "200" "$CODE"
SID_CMD=$(node -e "try{console.log(require('$ART/20-binding.json').binding?.sessionId??'')}catch(e){console.log('')}")
record "## commander sessionId=$SID_CMD"
CODE=$(get "/m1e2e/prepare?sessionId=$SID_CMD" 21-prepare.json); assert "prepare stub model" "200" "$CODE"
assert_in "selectModel probe-stub" "$(cat "$ART/21-prepare.json")" 'probe-stub'
CODE=$(get "/m1e2e/agents" 22-agents-before.json); AGENTS_BEFORE=$(node -e "try{console.log((require('$ART/22-agents-before.json').ids||[]).length)}catch(e){console.log(-1)}")
record "## agents before attach=$AGENTS_BEFORE"
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=PROBE_M1_TASK" 23-drive-task.json); assert "drive commander_task_create turn" "200" "$CODE"
CODE=$(get /commander/state 24-state-after-task.json); assert "state after commander_task_create" "200" "$CODE"
TASK_ID=$(node -e "try{const t=(require('$ART/24-state-after-task.json').tasks||[]);console.log(t[0]?.id??t[0]?.taskId??'')}catch(e){console.log('')}")
record "## taskId=$TASK_ID"; assert "task created" "1" "$([ -n "$TASK_ID" ] && echo 1 || echo 0)"

# 首次 dispatch：attach 提议 → needs_confirmation
ATTACH_TEXT="PROBE_M1R_ATTACH task=$TASK_ID ws=$WS_ID sid=$SID_WORK"
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=$(printf '%s' "$ATTACH_TEXT" | sed 's/ /%20/g')" 25-drive-attach.json)
assert "drive attach first call" "200" "$CODE"
assert_in "attach turn completed" "$(cat "$ART/25-drive-attach.json")" '"turn/end"'
assert_in "attach tool call emitted" "$(cat "$ART/25-drive-attach.json")" '"tool/call"'
CODE=$(get /commander/state 26-state-pending.json); assert "state after attach first" "200" "$CODE"
PENDING_OK=$(node -e "try{const j=require('$ART/26-state-pending.json');const p=j.pendingDispatch;process.exit(p&&typeof p.decisionId==='string'&&Array.isArray(p.candidates)&&p.candidates.length>0?0:1)}catch(e){process.exit(1)}"; echo $?)
assert "pendingDispatch non-null（含 decisionId + candidates[]）" "0" "$PENDING_OK"
DECISION=$(node -e "try{console.log(require('$ART/26-state-pending.json').pendingDispatch?.decisionId??'')}catch(e){console.log('')}")
record "## decisionId=$DECISION"
assert "pendingDispatch has decisionId" "1" "$([ -n "$DECISION" ] && echo 1 || echo 0)"
record "## pendingDispatch=$(head -c 700 "$ART/26-state-pending.json")"

# 二次 confirm：attach → dispatched、task queued、primarySessionId=工作会话、无新会话
CONFIRM_TEXT="PROBE_M1R_CONFIRM task=$TASK_ID decision=$DECISION ws=$WS_ID sid=$SID_WORK"
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=$(printf '%s' "$CONFIRM_TEXT" | sed 's/ /%20/g')" 27-drive-confirm.json)
assert "drive confirm call" "200" "$CODE"
assert_in "confirm turn completed" "$(cat "$ART/27-drive-confirm.json")" '"turn/end"'
CODE=$(get /commander/state 28-state-final.json); assert "state after confirm" "200" "$CODE"
PENDING_NULL=$(node -e "const fs=require('node:fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));console.log(String(j.pendingDispatch))" "$ART/28-state-final.json" 2>/dev/null)
assert "pendingDispatch null after confirm" "null" "$PENDING_NULL"
TASK_JSON=$(node -e "try{const t=(require('$ART/28-state-final.json').tasks||[]).find(x=>x.id==='$TASK_ID'||x.taskId==='$TASK_ID');console.log(JSON.stringify(t))}catch(e){console.log('null')}")
record "## task after confirm=$TASK_JSON"
TASK_STATUS=$(node -e "const fs=require('node:fs');const j=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const t=(j.tasks||[]).find(x=>x.id==='$TASK_ID'||x.taskId==='$TASK_ID');console.log(t?.status??'missing')" "$ART/28-state-final.json" 2>/dev/null)
assert "task status queued/running（attach 会 prompt 目标会话，可能立即 running）" "1" "$(printf '%s' "$TASK_STATUS" | grep -qE '^(queued|running)$' && echo 1 || echo 0)"
CODE=$(get "/m1e2e/agents" 29-agents-after.json); AGENTS_AFTER=$(node -e "try{console.log((require('$ART/29-agents-after.json').ids||[]).length)}catch(e){console.log(-1)}")
record "## agents after attach=$AGENTS_AFTER (before=$AGENTS_BEFORE)"
assert "attach 未新建工作会话（agents 数不变）" "$AGENTS_BEFORE" "$AGENTS_AFTER"
CODE=$(get "/commander/tasks/$TASK_ID" 30-task-by-id.json); assert "GET /commander/tasks/:id" "200" "$CODE"
assert_in "task record primarySessionId persisted" "$(cat "$ART/30-task-by-id.json")" "$SID_WORK"

# 收尾
kill "$BOOT_PID" 2>/dev/null; wait "$BOOT_PID" 2>/dev/null
if [ "$FAILED" -eq 0 ]; then record "## RESULT: PASS"; log "PASS (artifacts: $ART)"; exit 0; fi
record "## RESULT: FAIL"; log "FAIL (artifacts: $ART)"; exit 1
