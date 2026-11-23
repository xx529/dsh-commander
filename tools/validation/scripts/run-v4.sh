#!/bin/bash
# V4 storageDomain 验证 —— 一键复跑脚本（两次隔离 Host 启动，验证重启持久）
#
#   环境：DSH_HOME=<repo>/.probe/home  DSH_AGENTS_HOME=<repo>/.probe/agents  profile=probe
#   证据：docs/validation/v4-artifacts/（每次运行覆盖；命令与退出码写 commands.log）
#
# 用法：bash tools/validation/scripts/run-v4.sh
#       OUTDIR=/tmp/repro-v4 bash tools/validation/scripts/run-v4.sh   # 第三方复跑请指定 OUTDIR，避免覆盖执行人原始证据
#       （OUTDIR 默认是 docs/validation/v4-artifacts，仅为执行人落盘用）
# 退出码：0 = 脚本跑完（结论另由证据裁定）；非 0 = 环境/驱动失败。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
PROBE="$REPO/.probe"
DSH_HOME="$PROBE/home"
DSH_AGENTS_HOME="$PROBE/agents"
PROFILE=probe
ART="${OUTDIR:-$REPO/docs/validation/v4-artifacts}"
PATCH="$REPO/tools/validation/probes/probe-v4.patch.yml"

mkdir -p "$ART" "$DSH_HOME" "$DSH_AGENTS_HOME"
CMDS="$ART/commands.log"
: > "$CMDS"
export DSH_HOME DSH_AGENTS_HOME

SAFE_ENV=(env
  -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL
  -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

log() { echo "[run-v4] $*"; }

boot_host() {
  local name="$1"
  local out="$ART/boot-$name.out" err="$ART/boot-$name.err"
  log "boot ($name)"
  : > "$out"; : > "$err"
  "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$PATCH" --port 0 --no-open > "$out" 2> "$err" &
  BOOT_PID=$!
  local base=""
  for _ in $(seq 1 160); do
    base=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$out" | head -1)
    [ -n "$base" ] && break
    sleep 0.25
  done
  if [ -z "$base" ]; then log "FAIL: no URL"; sed -n '1,20p' "$err"; return 1; fi
  BASE="$base"
  for _ in $(seq 1 160); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/probe/v4/meta" || true)
    [ "$code" = "200" ] && break
    sleep 0.25
  done
  echo "## boot $name  $(date '+%Y-%m-%dT%H:%M:%S%z')  BASE=$BASE" >> "$CMDS"
  echo "   stdout: $out   stderr: $err ($(wc -c < "$err" | tr -d ' ') bytes)" >> "$CMDS"
}

call() {
  local step="$1" route="$2" out="$3"
  local status
  status=$(curl -sS -o "$ART/$out" -w '%{http_code}' "$BASE$route" 2> "$ART/.curl.err"); local rc=$?
  echo "\$ curl -sS -o $out -w '%{http_code}' '\$BASE$route'" >> "$CMDS"
  echo "  -> http=$status curl_exit=$rc" >> "$CMDS"
  [ "$rc" -eq 0 ] || { log "curl failed: $(cat "$ART/.curl.err")"; return 1; }
  log "$step -> http=$status"
}

shutdown_host() {
  local name="$1"
  local status
  status=$(curl -s -o "$ART/$name-quit.json" -w '%{http_code}' "$BASE/probe/v4/quit" || true)
  echo "\$ curl -s -o $name-quit.json -w '%{http_code}' \$BASE/probe/v4/quit   # $status" >> "$CMDS"
  wait "$BOOT_PID" 2>/dev/null
  echo "   host exit code: $?  (expected 0)" >> "$CMDS"
}

# live 基线（前后一致）
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-pre.txt" >/dev/null

# ---- 启动 1：定义层核查 + 8 步中的 1-6/8（写阶段） ----
log "=== boot 1：spec 核查 + run（写阶段）==="
boot_host write || exit 2
call V4-meta "/probe/v4/meta" "v4-meta.json"
call V4-spec "/probe/v4/spec" "v4-spec.json"
# 8.1 按冻结蓝图原名（boardEdits）实测：预期被存储层拒绝
call V4-run-blueprint "/probe/v4/run?tables=blueprint" "v4-run-blueprint.json"
# 8.2 探索性最小改名（boardEdits -> board_edits）后跑完 1-6/8 步
call V4-run-renamed "/probe/v4/run?tables=renamed" "v4-run-renamed.json"
call V4-tree-before "/probe/v4/tree" "v4-tree-before-restart.json"
shutdown_host "write"

# ---- 启动 2：重启后持久性 + schema open 校验（读阶段） ----
log "=== boot 2：restart-check + schema-open ==="
boot_host read || exit 2
call V4-restart-check-blueprint "/probe/v4/restart-check?tables=blueprint" "v4-restart-check-blueprint.json"
call V4-restart-check "/probe/v4/restart-check?tables=renamed" "v4-restart-check.json"
call V4-tree-after "/probe/v4/tree" "v4-tree-after-restart.json"
call V4-schema-open "/probe/v4/schema-open" "v4-schema-open.json"
call V4-tree-final "/probe/v4/tree" "v4-tree-final.json"
shutdown_host "read"

# live 基线（后）比对
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-post.txt" >/dev/null
if diff <(grep -v '^#' "$ART/live-pre.txt") <(grep -v '^#' "$ART/live-post.txt") > "$ART/live-state-diff.txt" 2>&1; then
  echo "LIVE-STATE: identical except timestamp header" | tee -a "$CMDS"
else
  echo "LIVE-STATE: DIFF DETECTED" | tee -a "$CMDS"
fi

log "done. artifacts: $ART"
