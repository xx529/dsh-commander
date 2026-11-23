#!/bin/bash
# V1 能力面板验证 —— 一键复跑脚本（隔离 web 探针 Host，不碰 live Desktop）
#
#   环境：DSH_HOME=<repo>/.probe/home  DSH_AGENTS_HOME=<repo>/.probe/agents
#         profile=probe（web 模板 + dsh-capability-settings v1.19.3 符号链接 + fixture skill）
#   证据：docs/validation/v1-artifacts/（每次运行覆盖；命令与退出码写 commands.log）
#
# 用法：
#   bash tools/validation/scripts/run-v1.sh
#   OUTDIR=/tmp/repro-v1 bash tools/validation/scripts/run-v1.sh   # 第三方复跑请指定 OUTDIR，避免覆盖执行人原始证据
#   （OUTDIR 默认是 docs/validation/v1-artifacts，仅为执行人落盘用）
#   JEV_ENV=/path/to/jev.env bash tools/validation/scripts/run-v1.sh   # 覆盖 key 文件路径
#
# 退出码：0 = 脚本跑完（是否 PASS 由证据与判据裁定，不由脚本退出码决定）；非 0 = 环境/驱动失败。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
PROBE="$REPO/.probe"
DSH_HOME="$PROBE/home"
DSH_AGENTS_HOME="$PROBE/agents"
PROFILE=probe
ART="${OUTDIR:-$REPO/docs/validation/v1-artifacts}"
WS="$PROBE/ws-cold"
JEV_ENV="${JEV_ENV:-/tmp/dsh-commander-probe/jev.env}"
PATCH="$REPO/tools/validation/probes/probe-v1.patch.yml"
PATCH_NOPANEL="$REPO/tools/validation/probes/probe-v1-nopanel.patch.yml"
DRAFT_ENC='%E9%9C%80%E8%A6%81%E5%8D%95%E6%B5%8B%E5%92%8C%E6%B5%8F%E8%A7%88%E5%99%A8%E8%87%AA%E5%8A%A8%E5%8C%96'  # 需要单测和浏览器自动化

mkdir -p "$ART" "$WS" "$DSH_HOME" "$DSH_AGENTS_HOME"
CMDS="$ART/commands.log"
: > "$CMDS"

export DSH_HOME DSH_AGENTS_HOME

# 清掉继承自本会话的 live Desktop 上下文变量，确保探针不指向 live profile
SAFE_ENV=(env
  -u DSH_PROFILE -u DSH_PROFILE_DIR -u DSH_SESSION_ID -u DSH_WEB_URL
  -u DSH_SHELL -u DSH_INSTALL_DIR -u DSH_NODE_EXECUTABLE -u DSH_USER_AGENT_SUFFIX)

# 有 key 文件才注入（不打印、不落盘；值只经继承环境传给探针进程）
if [ -f "$JEV_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; . "$JEV_ENV"; set +a
  KEY_NOTE="injected from $JEV_ENV (value never printed)"
else
  KEY_NOTE="absent (rank 正向用例将返回 no-config)"
fi
echo "## jev key: $KEY_NOTE" >> "$CMDS"

log() { echo "[run-v1] $*"; }

# ---- 启动探针 Host，等待 /probe/v1/health 可用，导出 BASE 变量 ----
boot_host() {
  local name="$1" patch="$2"
  local out="$ART/boot-$name.out" err="$ART/boot-$name.err"
  log "boot ($name): profile=$PROFILE patch=$(basename "$patch")"
  : > "$out"; : > "$err"
  "${SAFE_ENV[@]}" dsh --profile "$PROFILE" --patch "$patch" --port 0 --no-open > "$out" 2> "$err" &
  BOOT_PID=$!
  local base=""
  for _ in $(seq 1 160); do
    base=$(sed -n 's#^dsh web: \(http://[^/]*\).*#\1#p' "$out" | head -1)
    [ -n "$base" ] && break
    sleep 0.25
  done
  if [ -z "$base" ]; then
    log "FAIL: host did not print URL; stderr:"; sed -n '1,20p' "$err"
    return 1
  fi
  BASE="$base"
  for _ in $(seq 1 160); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/probe/v1/health" || true)
    [ "$code" = "200" ] && break
    sleep 0.25
  done
  echo "## boot $name  $(date '+%Y-%m-%dT%H:%M:%S%z')  BASE=$BASE" >> "$CMDS"
  echo "   stdout: $out" >> "$CMDS"
  echo "   stderr: $err ($(wc -c < "$err" | tr -d ' ') bytes)" >> "$CMDS"
}

shutdown_host() {
  local name="$1"
  local status
  status=$(curl -s -o "$ART/$name-quit.json" -w '%{http_code}' "$BASE/probe/v1/quit" || true)
  echo "\$ curl -s -o $name-quit.json -w '%{http_code}' \$BASE/probe/v1/quit   # $status" >> "$CMDS"
  wait "$BOOT_PID" 2>/dev/null
  echo "   host exit code: $?  (expected 0)" >> "$CMDS"
}

# ---- 单步调用：GET 路由 → 保存原始 JSON + 状态码 + 命令记录 ----
call() {
  local step="$1" route="$2" out="$3"
  local url="$BASE$route"
  local status
  status=$(curl -sS -o "$ART/$out" -w '%{http_code}' "$url" 2> "$ART/.curl.err")
  local rc=$?
  echo "\$ curl -sS -o $out -w '%{http_code}' '$url'" >> "$CMDS"
  echo "  -> http=$status curl_exit=$rc" >> "$CMDS"
  [ "$rc" -eq 0 ] || { log "curl failed on $step: $(cat "$ART/.curl.err")"; return 1; }
  log "$step -> http=$status ($out)"
}

# ---- 由 rank 返回按协议 §2.4 第 4 步构造 plan：applicable && score >= decisionThreshold ----
derive_plan() {
  local rankFile="$1" configFile="$2" planFile="$3" label="$4"
  node - "$ART/$rankFile" "$ART/$configFile" "$ART/$planFile" "$label" <<'NODE' 2>>"$CMDS"
const fs = require('node:fs')
const [rankFile, configFile, planFile, label] = process.argv.slice(2)
const rankPayload = JSON.parse(fs.readFileSync(rankFile, 'utf8'))
const rank = rankPayload.result ?? {}
const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')).config ?? {}
const threshold = typeof cfg.decisionThreshold === 'number' ? cfg.decisionThreshold : 0.5
const items = Array.isArray(rank.items) ? rank.items : []
const applicable = items.filter((item) => item.applicable === true)
const selected = applicable.filter((item) => typeof item.score === 'number' && item.score >= threshold)
const plan = selected.map((item) => ({ id: item.id, kind: item.kind, name: item.name, score: item.score, enabled: true }))
const out = {
  label, threshold, ok: rank.ok, code: rank.code ?? null,
  itemsTotal: items.length, applicableTotal: applicable.length, selectedCount: selected.length,
  applicableItems: applicable.map((item) => ({ id: item.id, kind: item.kind, name: item.name, score: item.score, enabledInSession: item.enabledInSession })),
  plan,
}
fs.writeFileSync(planFile, JSON.stringify(out, null, 2) + '\n')
console.error(`[run-v1] ${label}: threshold=${threshold} items=${items.length} applicable=${applicable.length} selected=${selected.length}`)
NODE
}

plan_ids() { node -e "const j=require('$ART/$1'); console.log((j.plan??[]).map(p=>p.id).join(','))"; }

# =====================================================================
# 阶段 0：环境版本 + live 基线（前）
# =====================================================================
log "env versions"
{
  echo "# V1 环境版本 $(date '+%Y-%m-%dT%H:%M:%S%z')"
  echo "## dsh CLI --version"
  dsh --version
  echo "## Desktop app version (Info.plist CFBundleShortVersionString)"
  plutil -extract CFBundleShortVersionString raw "/Applications/DeepSeek Harness.app/Contents/Info.plist" 2>/dev/null || echo "unavailable"
  echo "## node (shell)"
  node --version
  echo "## probe panel package (symlink target + version)"
  ls -l "$DSH_HOME/profiles/$PROFILE/node_modules/dsh-capability-settings"
  node -e "console.log(require('$DSH_HOME/profiles/$PROFILE/node_modules/dsh-capability-settings/package.json').version)"
  echo "## probe panel engines.dsh"
  node -e "console.log(JSON.stringify(require('$DSH_HOME/profiles/$PROFILE/node_modules/dsh-capability-settings/package.json').engines))"
  echo "## DSH_HOME / DSH_AGENTS_HOME / profile"
  echo "DSH_HOME=$DSH_HOME"
  echo "DSH_AGENTS_HOME=$DSH_AGENTS_HOME"
  echo "profile=$DSH_HOME/profiles/$PROFILE"
  echo "## git rev"
  git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo "unavailable"
} > "$ART/env-versions.txt" 2>&1
echo "## env-versions -> $ART/env-versions.txt" >> "$CMDS"

log "live-state pre"
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-pre.txt" >/dev/null
echo "## live-state pre  -> $ART/live-pre.txt" >> "$CMDS"

# =====================================================================
# 阶段 A：V1-C5 失败回退（面板行 disabled）
# =====================================================================
log "=== 阶段 A：无面板（C5 回退）==="
boot_host nopanel "$PATCH_NOPANEL" || exit 2
call A1-c5 "/probe/v1/health" "A1-c5-health.json"
call A2-c5 "/probe/v1/rank?sessionId=session-c5-nopanel&draft=probe" "A2-c5-rank.json"
shutdown_host "A"

# =====================================================================
# 阶段 B：冷会话路径（apply 先于 agent/created）—— C3/C4 硬证据
# =====================================================================
log "=== 阶段 B：冷会话路径（rank → apply → create → 重放 → 二次 rank）==="
boot_host main "$PATCH" || exit 2
call B0-health "/probe/v1/health" "B0-health.json"
call B1-config "/probe/v1/config" "B1-config.json"

COLD="session-v1cold-$(uuidgen | tr 'A-Z' 'a-z')"
echo "## cold sessionId=$COLD" >> "$CMDS"
log "cold sessionId=$COLD"

# B2: 冷会话 rank（无 live agent，panel 记 cold）
call B2-rank-cold "/probe/v1/rank?sessionId=$COLD&draft=$DRAFT_ENC&cwd=$WS" "B2-rank-cold.json"
derive_plan B2-rank-cold.json B1-config.json B2-plan.json cold
PLAN_IDS=$(plan_ids B2-plan.json)
echo "## cold plan ids: $PLAN_IDS" >> "$CMDS"
log "cold plan ids=$PLAN_IDS"
# B2b: 冷会话能力清单（对照 plan id 是否来自真实单元）
call B2b-units-cold "/probe/v1/units?sessionId=$COLD&cwd=$WS" "B2b-units-cold.json"

# B3: 冷会话 apply（预期 pending:true，只入队）
call B3-apply-cold "/probe/v1/apply?sessionId=$COLD&cwd=$WS&planIds=$PLAN_IDS" "B3-apply-cold.json"
call B4-events-before-create "/probe/v1/events" "B4-events-before-create.json"

# B5: 用预留 sessionId 建会话 → agent/created 触发排队重放
call B5-create "/probe/v1/create?sessionId=$COLD&cwd=$WS" "B5-create-cold.json"
sleep 2
call B6-session-after-create "/probe/v1/session?sessionId=$COLD" "B6-session-after-create.json"

# B7: 再 apply 一次 → 返回 pendingOutcome（重放回执）+ skipped already-applied
call B7-apply-replay "/probe/v1/apply?sessionId=$COLD&cwd=$WS&planIds=$PLAN_IDS" "B7-apply-replay.json"
# B8: 二次 rank → 计划内 id 的 enabledInSession
call B8-rank-after-replay "/probe/v1/rank?sessionId=$COLD&draft=$DRAFT_ENC&cwd=$WS" "B8-rank-after-replay.json"
call B9-state-after-replay "/probe/v1/state?sessionId=$COLD&cwd=$WS" "B9-state-cold.json"

# B10: prompt 一句（观察回合是否走通；环境无 provider 凭据时记录实际结果）
call B10-prompt "/probe/v1/prompt?sessionId=$COLD&text=%E5%87%86%E5%A4%87%E4%B8%AD%EF%BC%8C%E7%A1%AE%E8%AE%A4%E5%8F%AF%E7%94%A8%E8%83%BD%E5%8A%9B%E3%80%82" "B10-prompt-cold.json"

# B11-B13: 会话级开关的写方向验证（live 路径，plan=[] = 关闭全部可应用能力）
call B11-apply-disable-all "/probe/v1/apply?sessionId=$COLD&cwd=$WS&planIds=" "B11-apply-disable-all.json"
call B12-rank-after-disable "/probe/v1/rank?sessionId=$COLD&draft=$DRAFT_ENC&cwd=$WS" "B12-rank-after-disable.json"
call B13-state-after-disable "/probe/v1/state?sessionId=$COLD&cwd=$WS" "B13-state-after-disable.json"
# B14-B15: 再按 plan 启用回来
call B14-apply-enable "/probe/v1/apply?sessionId=$COLD&cwd=$WS&planIds=$PLAN_IDS" "B14-apply-enable.json"
call B15-rank-after-enable "/probe/v1/rank?sessionId=$COLD&draft=$DRAFT_ENC&cwd=$WS" "B15-rank-after-enable.json"
call B16-state-final "/probe/v1/state?sessionId=$COLD&cwd=$WS" "B16-state-final.json"

# =====================================================================
# 阶段 C：协议字面顺序（create → rank → apply → prompt → 二次 rank）
# =====================================================================
log "=== 阶段 C：live 路径（顺序：create → rank → apply）==="
call C1-create "/probe/v1/create?cwd=$WS" "C1-create-minted.json"
LIVE_SID=$(node -e "const j=require('$ART/C1-create-minted.json'); console.log(j?.result?.sessionId ?? '')")
echo "## live sessionId=$LIVE_SID" >> "$CMDS"
log "live sessionId=$LIVE_SID"
call C2-rank "/probe/v1/rank?sessionId=$LIVE_SID&draft=$DRAFT_ENC&cwd=$WS" "C2-rank-live.json"
derive_plan C2-rank-live.json B1-config.json C3-plan.json live
PLAN2_IDS=$(plan_ids C3-plan.json)
echo "## live plan ids: $PLAN2_IDS" >> "$CMDS"
log "live plan ids=$PLAN2_IDS"
call C4-apply-live "/probe/v1/apply?sessionId=$LIVE_SID&cwd=$WS&planIds=$PLAN2_IDS" "C4-apply-live.json"
call C5-rank-again "/probe/v1/rank?sessionId=$LIVE_SID&draft=$DRAFT_ENC&cwd=$WS" "C5-rank-after-apply.json"
call C6-state "/probe/v1/state?sessionId=$LIVE_SID&cwd=$WS" "C6-state-live.json"
call C7-prompt "/probe/v1/prompt?sessionId=$LIVE_SID&text=%E5%87%86%E5%A4%87%E4%B8%AD%EF%BC%8C%E7%A1%AE%E8%AE%A4%E5%8F%AF%E7%94%A8%E8%83%BD%E5%8A%9B%E3%80%82" "C7-prompt-live.json"
call C8-session "/probe/v1/session?sessionId=$LIVE_SID" "C8-session-live.json"

shutdown_host "B"

# 归档探针 summary（.probe 下，gitignored → 复制进 artifacts）
cp -f "$PROBE/evidence/v1-probe-summary.json" "$ART/v1-probe-summary.json" 2>/dev/null || true

# =====================================================================
# 阶段 D：live 基线（后）与一致性比对
# =====================================================================
log "live-state post"
bash "$REPO/tools/validation/scripts/live-state.sh" "$ART/live-post.txt" >/dev/null
echo "## live-state post -> $ART/live-post.txt" >> "$CMDS"
if diff <(grep -v '^#' "$ART/live-pre.txt") <(grep -v '^#' "$ART/live-post.txt") > "$ART/live-state-diff.txt" 2>&1; then
  echo "LIVE-STATE: identical except timestamp header" | tee -a "$CMDS"
else
  echo "LIVE-STATE: DIFF DETECTED (see $ART/live-state-diff.txt)" | tee -a "$CMDS"
fi

log "done. artifacts: $ART"
