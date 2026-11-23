#!/bin/bash
# V3 会话创建/模型选择/prompt/resume 验证 —— 一键复跑脚本（两次 Host 启动验证重启 resume）
#
#   环境：DSH_HOME=<repo>/.probe/home  DSH_AGENTS_HOME=<repo>/.probe/agents  profile=probe
#   模型：探针 stub provider probe-stub/stub-1（**验证用 stub，非真实模型**，不联网）
#   证据：docs/validation/v3-artifacts/
#
# 用法：bash tools/validation/scripts/run-v3.sh
#       OUTDIR=/tmp/repro-v3 bash tools/validation/scripts/run-v3.sh   # 第三方复跑请指定 OUTDIR，避免覆盖执行人原始证据
#       （OUTDIR 默认是 docs/validation/v3-artifacts，仅为执行人落盘用）
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
PROBE="$REPO/.probe"
DSH_HOME="$PROBE/home"
DSH_AGENTS_HOME="$PROBE/agents"
PROFILE=probe
ART="${OUTDIR:-$REPO/docs/validation/v3-artifacts}"
PATCH="$REPO/tools/validation/probes/probe-v3.patch.yml"
WS="$PROBE/ws-v3"

mkdir -p "$ART" "$DSH_HOME" "$DSH_AGENTS_HOME" "$WS"
CMDS="$ART/commands.log"
: > "$CMDS"
export DSH_HOME DSH_AGENTS_HOME
SAFE_ENV=(env -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)
log() { echo "[run-v3] $*"; }
json_get() { node -e "const j=require('$ART/$1'); console.log($2)" 2>/dev/null; }

{
  echo "# V3 环境 $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "dsh CLI: $(dsh --version)"
  echo "Desktop: $(plutil -extract CFBundleShortVersionString raw '/Applications/DeepSeek Harness.app/Contents/Info.plist' 2>/dev/null || echo unavailable)"
  echo "node(shell): $(node --version)"
  echo "DSH_HOME=$DSH_HOME"; echo "DSH_AGENTS_HOME=$DSH_AGENTS_HOME"
  echo "stub provider: probe-stub / stub-1（探针内注册，非真实模型）"
  echo "git rev: $(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unavailable)"
} > "$ART/env-versions.txt" 2>&1
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-pre.txt" >/dev/null

boot_host() {
  local name="$1"
  : > "$ART/boot-$name.out"; : > "$ART/boot-$name.err"
  "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$PATCH" --port 0 --no-open > "$ART/boot-$name.out" 2> "$ART/boot-$name.err" &
  BOOT_PID=$!
  BASE=""
  for _ in $(seq 1 160); do BASE=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$ART/boot-$name.out" | head -1); [ -n "$BASE" ] && break; sleep 0.25; done
  if [ -z "$BASE" ]; then log "FAIL: no URL ($name)"; head -10 "$ART/boot-$name.err"; return 1; fi
  for _ in $(seq 1 160); do code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/probe/v3/health" || true); [ "$code" = "200" ] && break; sleep 0.25; done
  echo "## boot $name $(date '+%Y-%m-%dT%H:%M:%S%z') BASE=$BASE stderr=$(wc -c < "$ART/boot-$name.err" | tr -d ' ')B" >> "$CMDS"
}
call() {
  local step="$1" route="$2" out="$3"; local status; status=$(curl -sS -o "$ART/$out" -w '%{http_code}' "$BASE$route" 2> "$ART/.curl.err"); local rc=$?
  echo "\$ curl -sS -o $out -w '%{http_code}' '\$BASE$route'" >> "$CMDS"; echo "  -> http=$status curl_exit=$rc" >> "$CMDS"
  [ "$rc" -eq 0 ] && log "$step -> http=$status" || log "$step curl failed: $(cat "$ART/.curl.err")"
}
shutdown_host() {
  local status; status=$(curl -s -o "$ART/$1-quit.json" -w '%{http_code}' "$BASE/probe/v3/quit" || true)
  echo "\$ curl -s -o $1-quit.json -w '%{http_code}' \$BASE/probe/v3/quit   # $status" >> "$CMDS"
  wait "$BOOT_PID" 2>/dev/null; echo "   host exit code: $?  (expected 0)" >> "$CMDS"
}

# ---------- boot 1：create / 参数互斥 / preset / selectModel / prompt / rebind / 重启前快照 ----------
log "=== boot 1：创建与模型/prompt ==="
boot_host one || exit 2
call V3-health "/probe/v3/health" "v3-health.json"
call V3-catalog "/probe/v3/catalog" "v3-catalog.json"
call V3-workspaces "/probe/v3/workspaces" "v3-workspaces.json"
call V3-create-cwd "/probe/v3/create-cwd?cwd=$WS" "v3-create-cwd.json"
CWD_SID=$(json_get "v3-create-cwd.json" "j.sessionId")
WSID=$(json_get "v3-workspaces.json" "j.workspaces?.[0]?.id ?? ''")
echo "## cwd sessionId=$CWD_SID workspaceId=$WSID" >> "$CMDS"
call V3-create-workspace "/probe/v3/create-workspace?workspaceId=$WSID" "v3-create-workspace.json"
call V3-create-both "/probe/v3/create-both?workspaceId=$WSID&cwd=$WS" "v3-create-both.json"
call V3-create-bad-preset "/probe/v3/create-bad-preset?cwd=$WS&preset=probe-nonexistent-preset" "v3-create-bad-preset.json"
call V3-select-model "/probe/v3/select-model?sessionId=$CWD_SID" "v3-select-model.json"
call V3-prompt "/probe/v3/prompt?sessionId=$CWD_SID&marker=PROBE_V3_OK" "v3-prompt.json"
call V3-rebind "/probe/v3/rebind?sessionId=$CWD_SID&cwd=$WS" "v3-rebind.json"
call V3-persist-info "/probe/v3/persist-info?sessionId=$CWD_SID" "v3-before-restart-probe.json"
shutdown_host "one"

PREV_SEQ=$(json_get "v3-before-restart-probe.json" "j.lastSeq")
echo "## pre-restart lastSeq=$PREV_SEQ" >> "$CMDS"

# ---------- boot 2：重启后 resume（不新建会话，直接 prompt 同一 sessionId） ----------
log "=== boot 2：重启后 resume ==="
boot_host two || exit 2
call V3-resume "/probe/v3/resume?sessionId=$CWD_SID&expectedPrevSeq=$PREV_SEQ" "v3-resume.json"
call V3-session-after "/probe/v3/session?sessionId=$CWD_SID" "v3-session-after-resume.json"
shutdown_host "two"

{
  echo "## assertions"
  node -e "const j=require('$ART/v3-create-cwd.json'); console.log('create-cwd: ok=',j.ok,'sid=',j.sessionId,'headerCwd=',j.headerCwd,'cwdMatches=',j.cwdMatches,'agentPreset=',j.result?.agentPreset)"
  node -e "const j=require('$ART/v3-create-workspace.json'); console.log('create-workspace: ok=',j.ok,'headerCwd=',j.headerCwd,'cwdEqualsWs=',j.cwdEqualsWorkspacePath,'attached=',j.sessionAttached,'sid=',j.sessionId)"
  node -e "const j=require('$ART/v3-create-both.json'); console.log('create-both: rejected=',j.rejected,'error=',JSON.stringify(j.error),'code=',j.errorCode)"
  node -e "const j=require('$ART/v3-create-bad-preset.json'); console.log('bad-preset: rejected=',j.rejected,'error=',JSON.stringify(j.error))"
  node -e "const j=require('$ART/v3-select-model.json'); console.log('select-model: ok=',j.ok,'selected=',JSON.stringify(j.selected),'matches=',j.matchesRequest,'selectionEvents=',JSON.stringify(j.selectionEvents))"
  node -e "const j=require('$ART/v3-prompt.json'); console.log('prompt: accepted=',JSON.stringify(j.accepted),'turnEnd=',JSON.stringify(j.turnEnd),'assistant=',JSON.stringify(j.assistantMessages))"
  node -e "const j=require('$ART/v3-rebind.json'); console.log('rebind: ok=',j.ok,'returnedDifferentId=',j.returnedDifferentId,'originalStillLive=',j.originalStillLive,'returnedSid=',j.result?.sessionId)"
  node -e "const j=require('$ART/v3-resume.json'); console.log('resume: ok=',j.ok,'accepted=',JSON.stringify(j.accepted),'seqStart=',j.seqStart,'lastSeq=',j.lastSeq,'continuous=',j.seqContinuous,'turnEnd=',JSON.stringify(j.turnEnd),'assistant=',JSON.stringify(j.assistantMessages),'liveAfter=',j.sessionIdUnchanged,'coldState=',JSON.stringify(j.coldState))"
} >> "$CMDS" 2>&1

bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-post.txt" >/dev/null
if diff <(grep -v '^#' "$ART/live-pre.txt") <(grep -v '^#' "$ART/live-post.txt") > "$ART/live-state-diff.txt" 2>&1; then
  echo "LIVE-STATE: identical except timestamp header" | tee -a "$CMDS"
else
  echo "LIVE-STATE: DIFF DETECTED" | tee -a "$CMDS"
fi
log "done. artifacts: $ART"
