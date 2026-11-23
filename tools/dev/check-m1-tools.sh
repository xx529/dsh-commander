#!/bin/bash
# M1 tools 真实回合可见性验证（隔离 profile；stub LLM 让模型发 commander_task_create 工具调用）
#
# 判据：指挥官会话在**真实 agent 回合**中调用 commander_task_create 后，`/commander/state.tasks`
# 出现该任务记录 → 证明 tools 已注册且可执行（boot 面 schemas() 不反映动态注册，不能作判据）。
#
# 用法：bash tools/dev/check-m1-tools.sh
#       PROBE_ROOT=/tmp/x OUTDIR=/tmp/ev bash tools/dev/check-m1-tools.sh
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_ROOT="${PROBE_ROOT:-/tmp/dsh-commander-m1-tools}"
DSH_HOME="$PROBE_ROOT/home"
DSH_AGENTS_HOME="$PROBE_ROOT/agents"
PROFILE=m1tools
ART="${OUTDIR:-$REPO/docs/validation/m1-tools-artifacts}"
export DSH_HOME DSH_AGENTS_HOME
mkdir -p "$ART"
CMDS="$ART/commands.log"; : > "$CMDS"
FAILED=0
log() { echo "[m1-tools] $*"; }
record() { echo "$*" >> "$CMDS"; }
assert() { local n="$1" e="$2" a="$3"; if [ "$e" = "$a" ]; then record "## ASSERT PASS $n ($a)"; log "PASS $n ($a)"; else record "## ASSERT FAIL $n expected=$e actual=$a"; log "FAIL $n expected=$e actual=$a"; FAILED=1; fi; }
assert_in() { if printf '%s' "$2" | grep -q -- "$3"; then record "## ASSERT PASS $1"; log "PASS $1"; else record "## ASSERT FAIL $1 (missing '$3')"; log "FAIL $1 (missing '$3')"; FAILED=1; fi; }
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

# 1) build
( cd "$REPO" && pnpm --filter dsh-commander build ) > "$ART/01-build.log" 2>&1
assert "build exit" "0" "$?"
# 2) fresh isolated profile + install
rm -rf "$DSH_HOME" "$DSH_AGENTS_HOME"; mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$PROBE_ROOT/ws"
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --from-default-profile web --dump-default-config > "$ART/02-default-config.yml" 2> "$ART/02-default-config.err"
assert "init profile exit" "0" "$?"
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
  dsh plugin --profile "$PROFILE" add "file:$REPO/packages/dsh-commander" > "$ART/03-plugin-add.log" 2>&1
assert "plugin add exit" "0" "$?"

# 3) boot with stub-tools driver fixture
PATCH="$PROBE_ROOT/m1-tools-driver.patch.yml"
cat > "$PATCH" <<EOF
- insert:
    - id: m1-tools-driver
      name: 'file://$REPO/tools/dev/spike/m1-tools-driver.mjs'
    - id: m0-workspace-fixture
      name: 'file://$REPO/tools/dev/spike/m0-workspace-fixture.mjs'
      config:
        path: $PROBE_ROOT/ws
EOF
COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$PATCH" --port 0 --no-open > "$ART/04-boot.out" 2> "$ART/04-boot.err" &
BOOT_PID=$!
BASE=""
for _ in $(seq 1 160); do BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/04-boot.out" | head -1); [ -n "$BASE" ] && break; sleep 0.25; done
[ -z "$BASE" ] && { log "FAIL boot"; cat "$ART/04-boot.err"; exit 2; }
for _ in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true); [ "$code" = "200" ] && break; sleep 0.25; done
record "## boot BASE=$BASE"
curl -s "$BASE/m1e2e/health" -o "$ART/05-driver-health.json"; record "## driver health=$(cat "$ART/05-driver-health.json")"

# 4) 等 workspace fixture 注册 → PUT workspaces（allowed/summary/policy）→ 用 workspaceId 绑定
for _ in $(seq 1 60); do grep -q "workspace created\|workspace exists" "$ART/04-boot.out" 2>/dev/null && break; sleep 0.25; done
sleep 0.5
curl -s "$BASE/commander/state" -o "$ART/05b-state-initial.json" 2>/dev/null
WS_ID=$(node -e "try{const j=require('$ART/05b-state-initial.json');console.log(j.workspaces?.[0]?.id ?? '')}catch(e){console.log('')}" 2>/dev/null)
record "## fixture workspace id=$WS_ID"
if [ -n "$WS_ID" ]; then
  curl -s -X PUT "$BASE/commander/workspaces" -H 'content-type: application/json' \
    -d "{\"workspaces\":[{\"id\":\"$WS_ID\",\"allowed\":true,\"summary\":\"probe workspace summary\",\"policy\":\"inherit\"}]}" \
    -o "$ART/05c-put-workspaces.json" -w 'put-workspaces http=%{http_code}\n' >> "$CMDS" 2>&1
fi
curl -s -X POST "$BASE/commander/binding" -H 'content-type: application/json' \
  -d "{\"mode\":\"new\",\"workspaceId\":\"$WS_ID\",\"requestId\":\"req_m1tools_bind_1\"}" -o "$ART/06-binding.json" -w 'binding http=%{http_code}\n' >> "$CMDS" 2>&1
SID=$(node -e "try{console.log(require('$ART/06-binding.json').binding?.sessionId ?? '')}catch{console.log('')}")
record "## bound sessionId=$SID"
[ -z "$SID" ] && { log "FAIL: no bound sessionId"; kill "$BOOT_PID" 2>/dev/null; exit 2; }
curl -s "$BASE/m1e2e/prepare?sessionId=$SID" -o "$ART/07-prepare.json"; record "## prepare=$(cat "$ART/07-prepare.json")"
assert_in "selectModel probe-stub" "$(cat "$ART/07-prepare.json")" '"probe-stub"'

# 5) 驱动一个真实回合：stub 模型发 commander_task_create
curl -s "$BASE/m1e2e/drive?sessionId=$SID&text=PROBE_M1_TASK" -o "$ART/08-drive.json" -w 'drive http=%{http_code}\n' >> "$CMDS" 2>&1
record "## drive events=$(head -c 700 "$ART/08-drive.json")"
assert_in "turn completed" "$(cat "$ART/08-drive.json")" '"turn/end"'
# 工具调用事件（tool/call + tool/result）应在回合内出现
assert_in "tool/call event present" "$(cat "$ART/08-drive.json")" '"tool/call"'
assert_in "tool/result event present" "$(cat "$ART/08-drive.json")" '"tool/result"'

# 6) 关键判据：state.tasks 出现任务（证明 commander_task_create 被真实执行）
sleep 1
curl -s "$BASE/commander/state" -o "$ART/09-state.json" -w 'state http=%{http_code}\n' >> "$CMDS" 2>&1
TASKS_JSON=$(node -e "try{const j=require('$ART/09-state.json');console.log(JSON.stringify(j.tasks))}catch{console.log('[]')}")
TASK_COUNT=$(node -e "try{console.log((require('$ART/09-state.json').tasks||[]).length)}catch{console.log(-1)}")
record "## tasks.count=$TASK_COUNT tasks=$TASKS_JSON"
assert "commander_task_create 真实执行（state.tasks >= 1）" "1" "$([ "${TASK_COUNT:-0}" -ge 1 ] && echo 1 || echo 0)"
assert_in "task title = probe-m1-tool-task" "$(cat "$ART/09-state.json")" 'probe-m1-tool-task'
# 事件里的 tool call 名称
curl -s "$BASE/m1e2e/events?sessionId=$SID" -o "$ART/10-events.json"
assert_in "stub emitted commander_task_create tool call" "$(cat "$ART/10-events.json")" 'stubCalls'
record "## stubCalls=$(node -e "try{console.log(JSON.stringify(require('$ART/10-events.json').stubCalls))}catch{console.log('?')}")"

# 7) tasks/:id 读回 + timeline
TASK_ID=$(node -e "try{console.log(require('$ART/09-state.json').tasks?.[0]?.id ?? require('$ART/09-state.json').tasks?.[0]?.taskId ?? '')}catch{console.log('')}")
record "## taskId=$TASK_ID"
if [ -n "$TASK_ID" ]; then
  curl -s "$BASE/commander/tasks/$TASK_ID" -o "$ART/11-task-by-id.json" -w 'task-by-id http=%{http_code}\n' >> "$CMDS" 2>&1
  assert_in "GET /commander/tasks/:id returns task" "$(cat "$ART/11-task-by-id.json")" 'probe-m1-tool-task'
fi

# 6b) commander_task_list 真实回合：验证返回含 workspaces[]（M1 live no_workspace 修复）
log "drive commander_task_list in real agent turn"
sleep 0.5
curl -s "$BASE/m1e2e/drive?sessionId=$SID&text=PROBE_M1_BOARD" -o "$ART/08b-drive-board.json" -w 'drive-board http=%{http_code}\n' >> "$CMDS" 2>&1
record "## drive-board events=$(head -c 500 "$ART/08b-drive-board.json")"
assert_in "board turn completed" "$(cat "$ART/08b-drive-board.json")" '"turn/end"'
assert_in "board tool/call present" "$(cat "$ART/08b-drive-board.json")" '"tool/call"'
assert_in "board tool/result present" "$(cat "$ART/08b-drive-board.json")" '"tool/result"'
curl -s "$BASE/m1e2e/events?sessionId=$SID" -o "$ART/10b-events-board.json" 2>/dev/null
BOARD_RESULT=$(node -e "try{const j=require('$ART/10b-events-board.json');const t=j.lastToolResult??'';console.log(typeof t==='string'?t:JSON.stringify(t))}catch(e){console.log('')}" 2>/dev/null)
record "## commander_task_list lastToolResult=$(printf '%s' "$BOARD_RESULT" | head -c 700)"
BOARD_BLOCKS=$(node -e "try{const j=require('$ART/10b-events-board.json');console.log(JSON.stringify(j.lastToolResultBlocks??null))}catch(e){console.log('null')}" 2>/dev/null)
record "## commander_task_list tool result blocks=$(printf '%s' "$BOARD_BLOCKS" | head -c 900)"
board_text_check() { # name needle
  if printf '%s' "$BOARD_RESULT" | grep -q -- "$2"; then
    record "## ASSERT PASS commander_task_list model-visible text contains $1"; log "PASS commander_task_list text contains $1"
  else
    record "## ASSERT FAIL commander_task_list model-visible text missing $1"; log "FAIL commander_task_list text missing $1"; FAILED=1
  fi
}
board_text_check "workspaces:" 'workspaces:'
board_text_check "tasks:" 'tasks:'
board_text_check '"id":' '"id":'
board_text_check '"allowed":true' '"allowed":true'
board_text_check '"policy"' '"policy"'
if [ -n "${WS_ID:-}" ] && printf '%s' "$BOARD_RESULT" | grep -q -- "\"id\":\"$WS_ID\""; then
  record "## ASSERT PASS commander_task_list text contains fixture workspace id=$WS_ID"; log "PASS commander_task_list text contains fixture id"
else
  record "## ASSERT FAIL commander_task_list text missing fixture workspace id=${WS_ID:-?}"; log "FAIL commander_task_list text missing fixture id"; FAILED=1
fi
# 值路径旁证：state.workspaces（同一 collectWorkspaceDirectory）结构完整
WS_FIELDS=$(node -e "try{const j=require('$ART/09b-state-after-board.json');const w=(j.workspaces||[])[0];console.log(w?Object.keys(w).sort().join(','):'empty')}catch(e){console.log('parse-error')}" 2>/dev/null)
record "## state.workspaces[0] fields=$WS_FIELDS"
# 不回归：state 仍有 tasks>=1 且字段完整
sleep 0.5
curl -s "$BASE/commander/state" -o "$ART/09b-state-after-board.json" -w 'state-after-board http=%{http_code}\n' >> "$CMDS" 2>&1
TASK_COUNT2=$(node -e "try{console.log((require('$ART/09b-state-after-board.json').tasks||[]).length)}catch{console.log(-1)}")
record "## after commander_task_list: tasks.count=$TASK_COUNT2"
assert "state.tasks 不回归（>=1）" "1" "$([ "${TASK_COUNT2:-0}" -ge 1 ] && echo 1 || echo 0)"

# 收尾
kill "$BOOT_PID" 2>/dev/null; wait "$BOOT_PID" 2>/dev/null
if [ "$FAILED" -eq 0 ]; then record "## RESULT: PASS"; log "PASS (artifacts: $ART)"; exit 0; fi
record "## RESULT: FAIL"; log "FAIL (artifacts: $ART)"; exit 1
