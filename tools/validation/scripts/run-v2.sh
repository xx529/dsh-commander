#!/bin/bash
# V2 会话停止/最后回复/pendingInteraction/去重 验证 —— 一键复跑脚本
#
#   环境：DSH_HOME=<repo>/.probe/home  DSH_AGENTS_HOME=<repo>/.probe/agents  profile=probe
#   模型：探针 stub provider probe-stub/stub-1（**非真实模型**，不联网）；审批：探针注入 answerer
#   证据：docs/validation/v2-artifacts/
#
# 用法：bash tools/validation/scripts/run-v2.sh
#       OUTDIR=/tmp/repro-v2 bash tools/validation/scripts/run-v2.sh   # 第三方复跑请指定 OUTDIR，避免覆盖执行人原始证据
#       （OUTDIR 默认是 docs/validation/v2-artifacts，仅为执行人落盘用）
# 退出码：0 = 脚本跑完（结论另由证据裁定）；非 0 = 环境/驱动失败。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
PROBE="$REPO/.probe"
DSH_HOME="$PROBE/home"
DSH_AGENTS_HOME="$PROBE/agents"
PROFILE=probe
ART="${OUTDIR:-$REPO/docs/validation/v2-artifacts}"
PATCH="$REPO/tools/validation/probes/probe-v2.patch.yml"

mkdir -p "$ART" "$DSH_HOME" "$DSH_AGENTS_HOME" "$PROBE/ws-v2"
CMDS="$ART/commands.log"
: > "$CMDS"
export DSH_HOME DSH_AGENTS_HOME
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

log() { echo "[run-v2] $*"; }
json_get() { node -e "const j=require('$ART/$1'); console.log($2)" 2>/dev/null; }

# 环境版本 + live 前基线
{
  echo "# V2 环境 $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "dsh CLI: $(dsh --version)"
  echo "Desktop: $(plutil -extract CFBundleShortVersionString raw '/Applications/DeepSeek Harness.app/Contents/Info.plist' 2>/dev/null || echo unavailable)"
  echo "node(shell): $(node --version)"
  echo "DSH_HOME=$DSH_HOME"
  echo "DSH_AGENTS_HOME=$DSH_AGENTS_HOME"
  echo "probe panel: $(node -e "console.log(require('$DSH_HOME/profiles/$PROFILE/node_modules/dsh-capability-settings/package.json').version)" 2>/dev/null)"
  echo "git rev: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unavailable)"
} > "$ART/env-versions.txt" 2>&1
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-pre.txt" >/dev/null

log "boot probe-v2"
"${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$PATCH" --port 0 --no-open > "$ART/boot.out" 2> "$ART/boot.err" &
BOOT_PID=$!
BASE=""
for _ in $(seq 1 160); do
  BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/boot.out" | head -1)
  [ -n "$BASE" ] && break
  sleep 0.25
done
if [ -z "$BASE" ]; then log "FAIL: no URL"; head -20 "$ART/boot.err"; exit 2; fi
for _ in $(seq 1 160); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/probe/v2/health" || true)
  [ "$code" = "200" ] && break
  sleep 0.25
done
echo "## boot $(date '+%Y-%m-%dT%H:%M:%S%z') BASE=$BASE  stderr=$(wc -c < "$ART/boot.err" | tr -d ' ')B" >> "$CMDS"

call() {
  local step="$1" route="$2" out="$3"
  local status; status=$(curl -sS -o "$ART/$out" -w '%{http_code}' "$BASE$route" 2> "$ART/.curl.err"); local rc=$?
  echo "\$ curl -sS -o $out -w '%{http_code}' '\$BASE$route'" >> "$CMDS"
  echo "  -> http=$status curl_exit=$rc" >> "$CMDS"
  [ "$rc" -eq 0 ] || log "curl failed: $(cat "$ART/.curl.err")"
  log "$step -> http=$status"
}

call V2-health "/probe/v2/health" "v2-health.json"
call V2-plain "/probe/v2/scenario?mode=plain" "v2-scenario-plain.json"
call V2-tool "/probe/v2/scenario?mode=tool" "v2-scenario-tool.json"
call V2-approval-wait "/probe/v2/approval" "v2-approval-wait.json"
APPROVAL_SID=$(json_get "v2-approval-wait.json" "j.sessionId")
echo "## approval sessionId=$APPROVAL_SID" >> "$CMDS"
call V2-release "/probe/v2/release?action=allow" "v2-approval-release.json"
call V2-cross-turn "/probe/v2/next-turn?sessionId=$APPROVAL_SID" "v2-cross-turn.json"
call V2-session-approval "/probe/v2/session?sessionId=$APPROVAL_SID" "v2-session-approval.json"

# 结论辅助断言（写入 commands.log，便于 tester 快速核对）
{
  echo "## assertions"
  node -e "const j=require('$ART/v2-scenario-plain.json'); console.log('plain: turnEnd=',JSON.stringify(j.turnEnd),'assistantSeq=',j.assistantMessages.at(-1)?.seq,'decision=',j.decisionAtEnd?.shouldInject,'inject1=',j.inject1?.injected,'inject2=',j.inject2?.reason)"
  node -e "const j=require('$ART/v2-scenario-tool.json'); console.log('tool: toolEvents=',JSON.stringify(j.toolEvents),'assistantSeqs=',JSON.stringify(j.assistantMessages.map(a=>a.seq)),'decision.lastSeq=',j.decisionAtEnd?.lastSeq,'text=',JSON.stringify(j.decisionAtEnd?.text),'midTurn=',JSON.stringify(j.midTurnEvaluations.map(m=>m.type)))"
  node -e "const j=require('$ART/v2-approval-wait.json'); console.log('approval-wait: askedSeq=',j.approvalAsked?.seq,'decided=',j.approvalDecided,'turnEnded=',j.turnEndedWhileWaiting,'decision=',j.decisionDuringWait?.shouldInject,'reason=',j.decisionDuringWait?.reason,'unpaired=',j.pendingInteractionSnapshot?.unpairedApprovals?.length)"
  node -e "const j=require('$ART/v2-approval-release.json'); console.log('release: pairs=',JSON.stringify(j.approvalPairs),'turnEnd=',JSON.stringify(j.turnEnd),'decision=',j.decisionAfterEnd?.shouldInject,'inject1=',j.inject1?.injected,'inject2=',j.inject2?.reason,'dedupeKey=',j.inject1?.dedupeKey)"
  node -e "const j=require('$ART/v2-cross-turn.json'); console.log('cross-turn: turnEnds=',JSON.stringify(j.turnEnds),'prev=',JSON.stringify(j.previousLastInjected),'decision=',j.decisionAfter?.shouldInject,'reason=',j.decisionAfter?.reason,'dedupeKey=',j.decisionAfter?.dedupeKey)"
} >> "$CMDS" 2>&1

# 收尾
status=$(curl -s -o "$ART/v2-quit.json" -w '%{http_code}' "$BASE/probe/v2/quit" || true)
echo "\$ curl -s -o v2-quit.json -w '%{http_code}' \$BASE/probe/v2/quit   # $status" >> "$CMDS"
wait "$BOOT_PID" 2>/dev/null
echo "   host exit code: $?  (expected 0)" >> "$CMDS"
cp -f "$ART/v2-probe-summary.json" "$ART/v2-probe-summary.json" 2>/dev/null || true

# live 后基线
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-post.txt" >/dev/null
if diff <(grep -v '^#' "$ART/live-pre.txt") <(grep -v '^#' "$ART/live-post.txt") > "$ART/live-state-diff.txt" 2>&1; then
  echo "LIVE-STATE: identical except timestamp header" | tee -a "$CMDS"
else
  echo "LIVE-STATE: DIFF DETECTED" | tee -a "$CMDS"
fi
log "done. artifacts: $ART"
