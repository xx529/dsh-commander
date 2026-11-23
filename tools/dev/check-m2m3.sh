#!/bin/bash
# M2/M3 隔离验证：PATCH/board_edits/注入/archive/restore + accept/rework/commander_task_report/turn-end 注入
#
# 用法：bash tools/dev/check-m2m3.sh
#   PROBE_ROOT=/tmp/x OUTDIR=/tmp/ev bash tools/dev/check-m2m3.sh
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PROBE_ROOT="${PROBE_ROOT:-/tmp/dsh-commander-m2m3}"
DSH_HOME="$PROBE_ROOT/home"; DSH_AGENTS_HOME="$PROBE_ROOT/agents"
PROFILE=m2m3
ART="${OUTDIR:-$REPO/docs/validation/m2m3-artifacts}"
export DSH_HOME DSH_AGENTS_HOME
mkdir -p "$ART" "$PROBE_ROOT/ws"
CMDS="$ART/commands.log"; : > "$CMDS"
FAILED=0
log() { echo "[m2m3] $*"; }
record() { echo "$*" >> "$CMDS"; }
assert() { local n="$1" e="$2" a="$3"; if [ "$e" = "$a" ]; then record "## ASSERT PASS $n ($a)"; log "PASS $n ($a)"; else record "## ASSERT FAIL $n expected=$e actual=$a"; log "FAIL $n expected=$e actual=$a"; FAILED=1; fi; }
jassert() { # name json-file node-expr(expected boolean)
  local n="$1" f="$2" expr="$3"
  local got; got=$(node -e "const fs=require('node:fs');try{const j=JSON.parse(fs.readFileSync('$f','utf8'));console.log(String($expr))}catch(e){console.log('ERR')}" 2>/dev/null)
  assert "$n" "true" "$got"
}
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

{
  echo "# M2/M3 隔离验证 $(date '+%Y-%m-%dT%H:%M:%S%z')"; echo "node: $(node --version)"; echo "dsh: $(dsh --version 2>/dev/null)"; echo "PROBE_ROOT=$PROBE_ROOT"
} > "$ART/env-versions.txt" 2>&1

# 1) build + verify-bundle
( cd "$REPO" && pnpm --filter dsh-commander build ) > "$ART/01-build.log" 2>&1
BUILD=$?; record "\$ pnpm --filter dsh-commander build # exit=$BUILD"; assert "build exit" "0" "$BUILD"; [ "$BUILD" -ne 0 ] && exit 2
node "$REPO/tools/dev/verify-bundle.mjs" "$REPO/packages/dsh-commander/lib/client.js" dsh-commander > "$ART/02-verify-bundle.json" 2>&1
VB=$?; record "\$ verify-bundle # exit=$VB"; assert "verify-bundle exit" "0" "$VB"
record "## client.js sha256=$(shasum -a 256 "$REPO/packages/dsh-commander/lib/client.js" | cut -d' ' -f1) size=$(wc -c < "$REPO/packages/dsh-commander/lib/client.js" | tr -d ' ')"

# 2) fresh profile + install + boot（COMMANDER_BOARD_MERGE_MS=20 缩短合并窗口）
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

PATCH="$PROBE_ROOT/m2m3.patch.yml"
cat > "$PATCH" <<EOF
- insert:
    - id: m1-tools-driver
      name: 'file://$REPO/tools/dev/spike/m1-tools-driver.mjs'
    - id: m0-workspace-fixture
      name: 'file://$REPO/tools/dev/spike/m0-workspace-fixture.mjs'
      config:
        path: $PROBE_ROOT/ws
EOF
COMMANDER_BOARD_MERGE_MS=2000 COMMANDER_BOOT_LOG=warn "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$PATCH" --port 0 --no-open > "$ART/05-boot.out" 2> "$ART/05-boot.err" &
BOOT_PID=$!
BASE=""
for _ in $(seq 1 160); do BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/05-boot.out" | head -1); [ -n "$BASE" ] && break; sleep 0.25; done
[ -z "$BASE" ] && { log "FAIL boot"; cat "$ART/05-boot.err"; exit 2; }
record "## boot BASE=$BASE"
for _ in $(seq 1 120); do code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/commander/health" || true); [ "$code" = "200" ] && break; sleep 0.25; done
for _ in $(seq 1 60); do grep -q "workspace created\|workspace exists" "$ART/05-boot.out" 2>/dev/null && break; sleep 0.25; done
sleep 0.5
record "## boot stderr=$(head -c 300 "$ART/05-boot.err")"

get() { local p="$1" out="$2" code; code=$(curl -s "$BASE$p" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ GET '$BASE$p' # http=$code"; echo "$code"; }
post() { local p="$1" body="$2" out="$3" code; code=$(curl -s -X POST "$BASE$p" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ POST '$BASE$p' -d '$body' # http=$code"; echo "$code"; }
patchr() { local p="$1" body="$2" out="$3" code; code=$(curl -s -X PATCH "$BASE$p" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ PATCH '$BASE$p' -d '$body' # http=$code"; echo "$code"; }
put() { local p="$1" body="$2" out="$3" code; code=$(curl -s -X PUT "$BASE$p" -H 'content-type: application/json' -d "$body" -o "$ART/$out" -w '%{http_code}' 2>>"$ART/.curl.err"); record "\$ PUT '$BASE$p' -d '$body' # http=$code"; echo "$code"; }

# 3) 基础状态：state 新字段 + workspace fixture + binding + stub + commander_task_create
CODE=$(get /commander/state 10-state-initial.json); assert "GET /commander/state" "200" "$CODE"
jassert "state.metrics 存在且含 injections/deduped/pendingSkipped/injectFailures/projectionUnavailable" "$ART/10-state-initial.json" "['injections','deduped','pendingSkipped','injectFailures','projectionUnavailable'].every(k=>typeof j.metrics?.[k]==='number')"
jassert "state.workSessions 数组存在" "$ART/10-state-initial.json" "Array.isArray(j.workSessions)"
jassert "state.archiveSummary 字段存在" "$ART/10-state-initial.json" "'archiveSummary' in j"
WS_ID=$(node -e "try{console.log(require('$ART/10-state-initial.json').workspaces?.[0]?.id??'')}catch(e){console.log('')}")
record "## fixture workspace=$WS_ID"; assert "fixture workspace registered" "1" "$([ -n "$WS_ID" ] && echo 1 || echo 0)"
CODE=$(put /commander/workspaces "{\"workspaces\":[{\"id\":\"$WS_ID\",\"allowed\":true,\"summary\":\"m2m3 probe workspace\",\"policy\":\"inherit\"}]}" 11-put-workspaces.json); assert "PUT /commander/workspaces" "200" "$CODE"
CODE=$(post /commander/binding "{\"mode\":\"new\",\"workspaceId\":\"$WS_ID\",\"requestId\":\"req_m2m3_bind_1\"}" 12-binding.json); assert "binding" "200" "$CODE"
SID_CMD=$(node -e "try{console.log(require('$ART/12-binding.json').binding?.sessionId??'')}catch(e){console.log('')}"); record "## commander session=$SID_CMD"
CODE=$(get "/m1e2e/prepare?sessionId=$SID_CMD" 13-prepare.json); assert "prepare stub model" "200" "$CODE"
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=PROBE_M1_TASK" 14-drive-task.json); assert "drive commander_task_create" "200" "$CODE"
CODE=$(get /commander/state 15-state-after-task.json)
TASK=$(node -e "try{const t=(require('$ART/15-state-after-task.json').tasks||[])[0];console.log(t?.id??'')}catch(e){console.log('')}")
record "## task=$TASK"; assert "task created" "1" "$([ -n "$TASK" ] && echo 1 || echo 0)"

# 4) M2: PATCH 合法/非法迁移 + board_edits + 重复 editId
CODE=$(patchr "/commander/board/tasks/$TASK" "{\"field\":\"title\",\"value\":\"m2m3 probe title\",\"editId\":\"edit_1\"}" 20-patch-title.json); assert "PATCH title 200" "200" "$CODE"
jassert "PATCH title 生效 + boardEdit 返回" "$ART/20-patch-title.json" "j.ok===true && j.task?.title==='m2m3 probe title' && j.boardEdit?.editId==='edit_1' && j.duplicate===false"
CODE=$(patchr "/commander/board/tasks/$TASK" "{\"field\":\"priority\",\"value\":\"high\",\"editId\":\"edit_2\"}" 21-patch-priority.json); assert "PATCH priority 200" "200" "$CODE"
jassert "PATCH priority 生效" "$ART/21-patch-priority.json" "j.task?.priority==='high'"
CODE=$(patchr "/commander/board/tasks/$TASK" "{\"field\":\"title\",\"value\":\"m2m3 probe title\",\"editId\":\"edit_1\"}" 22-patch-duplicate.json); assert "PATCH 重复 editId 200" "200" "$CODE"
jassert "PATCH 重复 editId duplicate=true" "$ART/22-patch-duplicate.json" "j.duplicate===true"
CODE=$(patchr "/commander/board/tasks/$TASK" "{\"field\":\"status\",\"value\":\"done\",\"editId\":\"edit_3\"}" 23-patch-illegal-done.json); assert "PATCH status=done（带 editId）→ 409 conflict" "409" "$CODE"
jassert "conflict 提示走 accept/archive" "$ART/23-patch-illegal-done.json" "/accept|archive/.test(String(j.message||''))"
CODE=$(patchr "/commander/board/tasks/$TASK" "{\"field\":\"bogus\",\"value\":\"x\"}" 24-patch-bogus-field.json); assert "PATCH 非法字段 → 400" "400" "$CODE"
jassert "PATCH 非法字段 code=invalid_request" "$ART/24-patch-bogus-field.json" "j.code==='invalid_request'"
# board_edits 落盘（任务详情） + 等合并注入
CODE=$(get "/commander/tasks/$TASK" 25-task-detail.json); assert "GET task detail" "200" "$CODE"
jassert "task detail 含 boardEdits（>=2，顶层）" "$ART/25-task-detail.json" "Array.isArray(j.boardEdits) && j.boardEdits.length>=2 && j.stale===false"
jassert "task version 字段存在 + 顶层 stale 布尔" "$ART/25-task-detail.json" "typeof j.task?.version==='number' && typeof j.stale==='boolean'"
sleep 2.8
CODE=$(get "/m1e2e/events?sessionId=$SID_CMD" 26-cmd-events.json)
BOARD_EDIT_N=$(node -e "try{const es=require('$ART/26-cmd-events.json').events||[];console.log(es.filter(e=>e.type==='user/message'&&String(e.text||'').includes('[board-edit]')).length)}catch(e){console.log(-1)}" 2>/dev/null)
record "## commander [board-edit] user messages=$BOARD_EDIT_N"
assert "[board-edit] 合并注入 = 1 条（MERGE_MS=2000，2 次 PATCH 合并）" "1" "$BOARD_EDIT_N"
CODE=$(get "/commander/tasks/$TASK" 25b-task-detail-after-inject.json)
jassert "boardEdits 全部已注入（合并 flush 后 injectedAt 非空）" "$ART/25b-task-detail-after-inject.json" "(j.boardEdits||[]).every(e=>typeof e.injectedAt==='number') && (j.boardEdits||[]).length>=2"

CODE=$(get /commander/state 27-state-after-edits.json)
jassert "turn/end 注入 metrics 可用（injections/deduped/pendingSkipped/injectFailures 为数字）" "$ART/27-state-after-edits.json" "['injections','deduped','pendingSkipped','injectFailures'].every(k=>typeof j.metrics?.[k]==='number')"

# 5) M2: archive / restore / 列表
CODE=$(post "/commander/tasks/$TASK/archive" '{}' 30-archive-draft.json); assert "draft 任务 archive → 409 conflict（需 review/done/cancelled）" "409" "$CODE"
jassert "archive 冲突 code=conflict" "$ART/30-archive-draft.json" "j.code==='conflict'"
CODE=$(get "/commander/archive?limit=10" 32-archive-list-empty.json); assert "GET /commander/archive（空列表）" "200" "$CODE"
jassert "archive 列表结构 ok/tasks[]/nextCursor/rev" "$ART/32-archive-list-empty.json" "j.ok===true && Array.isArray(j.tasks) && 'nextCursor' in j && typeof j.rev==='number'"

# 6) M3: attach 到工作会话（复用 M1R 流程）→ 工作会话 turn → turn/end 注入 [session-reply]
WS_PATH=$(node -e "try{console.log(require('$ART/10-state-initial.json').workspaces?.[0]?.path??'')}catch(e){console.log('')}")
CODE=$(get "/m1e2e/create-session?cwd=$WS_PATH" 40-create-work.json); assert "create work session" "200" "$CODE"
SID_WORK=$(node -e "try{console.log(require('$ART/40-create-work.json').created?.sessionId??'')}catch(e){console.log('')}")
record "## work session=$SID_WORK"
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=$(printf 'PROBE_M1R_ATTACH task=%s ws=%s sid=%s' "$TASK" "$WS_ID" "$SID_WORK" | sed 's/ /%20/g')" 41-drive-attach.json); assert "drive attach first" "200" "$CODE"
CODE=$(get /commander/state 42-state-pending.json)
DECISION=$(node -e "try{console.log(require('$ART/42-state-pending.json').pendingDispatch?.decisionId??'')}catch(e){console.log('')}")
record "## decision=$DECISION"; assert "pendingDecision 存在" "1" "$([ -n "$DECISION" ] && echo 1 || echo 0)"
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=$(printf 'PROBE_M1R_CONFIRM task=%s decision=%s ws=%s sid=%s' "$TASK" "$DECISION" "$WS_ID" "$SID_WORK" | sed 's/ /%20/g')" 43-drive-confirm.json); assert "drive attach confirm" "200" "$CODE"
CODE=$(get "/m1e2e/prepare?sessionId=$SID_WORK" 44-prepare-work.json); assert "prepare stub model for work session" "200" "$CODE"
CMD_INJ_BEFORE=$(node -e "try{const es=require('$ART/26-cmd-events.json').events||[];console.log(es.filter(e=>e.type==='user/message'&&String(e.text||'').includes('[session-reply]')).length)}catch(e){console.log(0)}" 2>/dev/null)
CODE=$(get "/m1e2e/drive?sessionId=$SID_WORK&text=PROBE_M3_WORK%20probe%20reply" 45-drive-work-turn.json); assert "drive work session turn（stub 回复→turn/end）" "200" "$CODE"
sleep 2.0
CODE=$(get "/m1e2e/events?sessionId=$SID_CMD" 46-cmd-events-after-work.json)
REPLY_INJ=$(node -e "try{const es=require('$ART/46-cmd-events-after-work.json').events||[];console.log(es.filter(e=>e.type==='user/message'&&String(e.text||'').includes('[session-reply]')).length)}catch(e){console.log(-1)}" 2>/dev/null)
record "## commander [session-reply] injections=$REPLY_INJ (before=$CMD_INJ_BEFORE)"
assert "[session-reply] 注入到指挥官会话（>=1）" "1" "$([ "${REPLY_INJ:-0}" -ge 1 ] && echo 1 || echo 0)"
CODE=$(get /commander/state 47-state-after-inj.json)
jassert "metrics.injections>=1（turn/end 注入成功）" "$ART/47-state-after-inj.json" "j.metrics?.injections>=1"
jassert "state.workSessions 含工作会话" "$ART/47-state-after-inj.json" "(j.workSessions||[]).some(w=>w.sessionId==='$SID_WORK'||w.id==='$SID_WORK')"

# 7) M3: commander_task_report → review → rework（成功）→ commander_task_report → accept（done）
SEQ_FROM=$(node -e "try{const es=require('$ART/45-drive-work-turn.json').events||[];const u=es.find(e=>e.type==='user/message');console.log(u?.seq??1)}catch(e){console.log(1)}" 2>/dev/null)
SEQ_TO=$(node -e "try{const es=require('$ART/45-drive-work-turn.json').events||[];const t=es.find(e=>e.type==='turn/end');console.log(t?.seq??999999)}catch(e){console.log(999999)}" 2>/dev/null)
record "## organize seqFrom=$SEQ_FROM seqTo=$SEQ_TO"
# HIGH-1：空 acceptance + delivered → invalid_request（architect 复核要求；backend 修复后应 PASS）
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=$(printf 'PROBE_M3_EMPTY task=%s sid=%s seqFrom=%s seqTo=%s' "$TASK" "$SID_WORK" "$SEQ_FROM" "$SEQ_TO" | sed 's/ /%20/g')" 49-drive-organize-empty.json); assert "drive commander_task_report(空 acceptance)" "200" "$CODE"
CODE=$(get "/m1e2e/events?sessionId=$SID_CMD" 49b-events-organize-empty.json)
EMPTY_RESULT=$(node -e "try{const j=require('$ART/49b-events-organize-empty.json');const t=j.lastToolResult??'';console.log(typeof t==='string'?t:JSON.stringify(t))}catch(e){console.log('')}" 2>/dev/null)
record "## organize(empty acceptance) result=$(printf '%s' "$EMPTY_RESULT" | head -c 500)"
if printf '%s' "$EMPTY_RESULT" | grep -q 'invalid_request'; then
  record "## ASSERT PASS HIGH-1 空 acceptance+delivered → invalid_request"; log "PASS HIGH-1 empty acceptance rejected"
else
  record "## ASSERT FAIL HIGH-1 空 acceptance+delivered 未返回 invalid_request（期望 backend 修复已生效）"; log "FAIL HIGH-1 empty acceptance not rejected"; FAILED=1
fi
CODE=$(get /commander/state 49c-state-after-empty.json)
jassert "HIGH-1：空 acceptance 后任务未进入 review" "$ART/49c-state-after-empty.json" "(j.tasks||[]).find(t=>t.id==='$TASK')?.status!=='review'"
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=$(printf 'PROBE_M3_ORGANIZE task=%s sid=%s seqFrom=%s seqTo=%s' "$TASK" "$SID_WORK" "$SEQ_FROM" "$SEQ_TO" | sed 's/ /%20/g')" 50-drive-organize.json); assert "drive commander_task_report" "200" "$CODE"
CODE=$(get /commander/state 51-state-review.json)
jassert "commander_task_report 后任务 status=review" "$ART/51-state-review.json" "(j.tasks||[]).find(t=>t.id==='$TASK')?.status==='review'"
CODE=$(get "/commander/tasks/$TASK" 52-task-detail-review.json)
jassert "review 任务 acceptance>=1（顶层）" "$ART/52-task-detail-review.json" "Array.isArray(j.acceptance)&&j.acceptance.length>=1"
CODE=$(post "/commander/tasks/$TASK/rework" '{"comment":"probe rework"}' 53-rework.json); assert "POST rework（review→running）200" "200" "$CODE"
jassert "rework 后 status=running" "$ART/53-rework.json" "j.task?.status==='running'"
# 再次 organize → review → accept
CODE=$(get "/m1e2e/drive?sessionId=$SID_CMD&text=$(printf 'PROBE_M3_ORGANIZE task=%s sid=%s seqFrom=%s seqTo=%s' "$TASK" "$SID_WORK" "$SEQ_FROM" "$SEQ_TO" | sed 's/ /%20/g')" 54-drive-organize2.json); assert "drive commander_task_report #2" "200" "$CODE"
CODE=$(get /commander/state 55-state-review2.json)
jassert "第二次 organize 后 status=review" "$ART/55-state-review2.json" "(j.tasks||[]).find(t=>t.id==='$TASK')?.status==='review'"
CODE=$(post "/commander/tasks/$TASK/accept" '{}' 56-accept.json); assert "POST accept 200" "200" "$CODE"
jassert "accept 后 status=done" "$ART/56-accept.json" "j.task?.status==='done'"
CODE=$(post "/commander/tasks/$TASK/archive" '{}' 58-archive-done.json); assert "done 任务 archive 200" "200" "$CODE"
jassert "archive 后 archivedAt 存在" "$ART/58-archive-done.json" "typeof j.task?.archivedAt==='number'"
CODE=$(get /commander/state 58b-state-archived.json)
jassert "state.tasks 排除 archived 任务" "$ART/58b-state-archived.json" "!(j.tasks||[]).some(t=>t.id==='$TASK')"
CODE=$(get "/commander/archive?limit=10" 58c-archive-list.json); assert "GET /commander/archive" "200" "$CODE"
jassert "archive 列表含该任务" "$ART/58c-archive-list.json" "(j.tasks||[]).some(t=>t.id==='$TASK')"
CODE=$(post "/commander/tasks/$TASK/restore" '{}' 58d-restore.json); assert "POST restore 200" "200" "$CODE"
CODE=$(get /commander/state 58e-state-restored.json)
jassert "restore 后 state.tasks 重新包含" "$ART/58e-state-restored.json" "(j.tasks||[]).some(t=>t.id==='$TASK')"
CODE=$(post "/commander/tasks/$TASK/rework" '{}' 57-rework-conflict.json); assert "rework 非 review → 409" "409" "$CODE"
CODE=$(get "/commander/tasks/nonexistent_m2m3" 58-task-404.json); assert "tasks/:id 不存在 → 404" "404" "$CODE"
# 回归：health/state/sessions
CODE=$(get /commander/health 59-health.json); assert "health 200（无回归）" "200" "$CODE"
CODE=$(get "/commander/sessions?workspaceId=$WS_ID" 60-sessions.json); assert "sessions 路由无回归" "200" "$CODE"

kill "$BOOT_PID" 2>/dev/null; wait "$BOOT_PID" 2>/dev/null
if [ "$FAILED" -eq 0 ]; then record "## RESULT: PASS"; log "PASS (artifacts: $ART)"; exit 0; fi
record "## RESULT: FAIL"; log "FAIL (artifacts: $ART)"; exit 1
