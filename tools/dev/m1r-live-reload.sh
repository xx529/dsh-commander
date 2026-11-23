#!/bin/bash
# M1R/M2/M3 live 重载流程脚本（默认 dry-run；不自动写 live）
#
# 背景（上一阶段 live 实测，docs/validation/m1-boot.md §6 / HANDOVER §3.3）：
#   - Host/Client 变更 → 需要把新构建装进 profile 并重载插件：
#       plugin_manager: remove_bundle → install_bundle file:<绝对包路径> → set_plugin 重载
#     （**无需整机重启 DSH**；M1 阶段已用该方式让新 Host 生效）
#   - 安装是“安装时快照”语义：新增 lib 文件 / tsc 原子重写断开 hardlink 后，单纯刷新/重启不会同步
#     → 必须重装（见 docs/validation/m0-live-install.md §7.7/§7.8、m1-boot §7.9/§7.10）。
#
# 用法：
#   bash tools/dev/m1r-live-reload.sh                     # 预检 + 打印重载步骤（只读，默认）
#   bash tools/dev/m1r-live-reload.sh --post-verify       # 重载后只读复查（health/state/config/jev + verify-live）
#   CONFIRM_LIVE=yes ALLOW_CLI_RELOAD=yes bash ...        # 在**用户终端**里走 CLI remove+add（agent 沙箱禁止写 ~/.dsh）
#   OUTDIR=/tmp/x bash ...                                # 证据目录覆盖（默认 docs/validation/m1r-artifacts）
#
# 退出码：0=预检/复查通过；2=预检失败（构建或文件集不一致）；3=需要人工执行（agent 无法写 live）；4=执行失败
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PKG="$REPO/packages/dsh-commander"
PROFILE=desktop
LIVE_HOME="${DSH_HOME_OVERRIDE:-$HOME/.dsh}"
LIVE_PKG="$LIVE_HOME/profiles/$PROFILE/node_modules/dsh-commander"
ART="${OUTDIR:-$REPO/docs/validation/m1r-artifacts}"
MODE=plan
for arg in "$@"; do
  case "$arg" in
    --plan) MODE=plan ;;
    --post-verify) MODE=post-verify ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
mkdir -p "$ART"
LOG="$ART/reload.log"; : > "$LOG"
log() { echo "[m1r-reload] $*" | tee -a "$LOG"; }
record() { echo "$*" >> "$LOG"; }
FAILED=0
fail() { log "FAIL: $*"; FAILED=1; }

# ---------- 预检（只读） ----------
preflight() {
  log "repo=$REPO profile=$PROFILE mode=$MODE"
  # 1) 构建产物
  [ -f "$PKG/lib/host/index.js" ] || fail "缺少 Host 产物 $PKG/lib/host/index.js（先 pnpm --filter dsh-commander build）"
  [ -f "$PKG/lib/client.js" ] || fail "缺少 Client 产物 $PKG/lib/client.js"
  if [ -f "$PKG/lib/client.js" ]; then
    node "$REPO/tools/dev/verify-bundle.mjs" "$PKG/lib/client.js" dsh-commander > "$ART/verify-bundle.json" 2>&1
    VB=$?; record "\$ verify-bundle # exit=$VB"; [ "$VB" -eq 0 ] || fail "client bundle 契约校验失败（见 verify-bundle.json）"
    record "## client.js sha256=$(shasum -a 256 "$PKG/lib/client.js" | cut -d' ' -f1) size=$(wc -c < "$PKG/lib/client.js" | tr -d ' ')"
  fi
  # 2) repo vs live lib 文件集一致性（快照语义检查）
  if [ -d "$LIVE_PKG/lib" ]; then
    REPO_JS=$(find "$PKG/lib" -name '*.js' | wc -l | tr -d ' ')
    LIVE_JS=$(find "$LIVE_PKG/lib" -name '*.js' | wc -l | tr -d ' ')
    MISSING=$(comm -23 <( cd "$PKG/lib" && find . -name '*.js' | sort ) <( cd "$LIVE_PKG/lib" && find . -name '*.js' | sort ) 2>/dev/null | head -50)
    MISSING_N=$(printf '%s\n' "$MISSING" | grep -c . 2>/dev/null || true)
    record "## lib js: repo=$REPO_JS live=$LIVE_JS missing=$MISSING_N"
    if [ "$MISSING_N" -gt 0 ]; then
      fail "live 副本缺 $MISSING_N 个新 lib 文件（如 $(printf '%s' "$MISSING" | head -3 | tr '\n' ' ')）→ 必须重装（remove_bundle+install_bundle）"
    else
      log "lib 文件集一致：repo=$REPO_JS live=$LIVE_JS"
    fi
  else
    fail "live profile 未安装 dsh-commander（$LIVE_PKG 不存在）→ 先走安装流程（install-live-m0.sh）"
  fi
  # 3) profile dependency / bundles
  if [ -f "$LIVE_HOME/profiles/$PROFILE/package.json" ]; then
    node - "$LIVE_HOME/profiles/$PROFILE/package.json" "$ART/profile-summary.json" <<'NODE'
const fs = require('node:fs')
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const deps = pkg.dependencies ?? {}
const bundles = pkg.dsh?.profile?.bundles ?? []
const out = { dependency: deps['dsh-commander'] ?? null, bundleListed: bundles.includes('dsh-commander'), bundleCount: bundles.length }
fs.writeFileSync(process.argv[3], JSON.stringify(out, null, 2) + '\n')
console.log(JSON.stringify(out))
NODE
    record "\$ profile summary: $(cat "$ART/profile-summary.json" | tr '\n' ' ')"
  fi
  # 4) 记录设计说明：安装是快照语义
  record "## 重载方式（上一阶段 live 已验证）：plugin_manager remove_bundle → install_bundle file:$PKG → set_plugin 重载（无需整机重启）"
}

# ---------- dry-run：打印可执行步骤 ----------
print_steps() {
  cat <<EOF | tee -a "$LOG"

================ M1R/M2/M3 live 重载步骤（由 Lead 用 plugin_manager 工具/终端执行）================
# 说明：devops agent 沙箱不能写 ~/.dsh，因此脚本只做预检 + 打印；以下动作由 Lead 执行（上一阶段已实测可行）。
# 0) 构建最新（devops 已完成；如代码有更新先重跑）
cd $REPO && pnpm --filter dsh-commander build
# 1) 卸载旧的安装快照
plugin_manager action=remove_bundle target=dsh-commander
# 2) 从最新构建的绝对路径安装（快照式；会带上新增/重写的 lib 文件）
plugin_manager action=install_bundle target=$PKG
# 3) 重载插件（不重启整机 DSH）
plugin_manager action=set_plugin target=dsh-commander enabled=true
#    等价 CLI（用户终端；会写 ~/.dsh；agent 不可用）：
#    dsh plugin --profile desktop remove dsh-commander && dsh plugin --profile desktop add $PKG
#    如 CLI 路径无 set_plugin 能力，则退出并重开 DSH（会中断会话）
# 4) 重载后只读复查（devops/Lead 均可）
bash $REPO/tools/dev/m1r-live-reload.sh --post-verify
#    或带页面 token 的完整检查：
#    node $REPO/tools/dev/verify-live-m0.mjs --url 'http://127.0.0.1:<PORT>/?token=…'
================ 结束 ================
EOF
}

# ---------- post-verify：只读复查 ----------
post_verify() {
  local base="${DSH_WEB_URL:-}"
  if [ -z "$base" ]; then
    log "WARN: 未设置 DSH_WEB_URL；跳过 HTTP 复查"
    return
  fi
  log "post-verify origin=$base"
  local h s c j
  h=$(curl -s -o "$ART/post-health.json" -w '%{http_code}' "$base/commander/health" 2>/dev/null)
  s=$(curl -s -o "$ART/post-state.json" -w '%{http_code}' "$base/commander/state" 2>/dev/null)
  c=$(curl -s -o "$ART/post-config.json" -w '%{http_code}' "$base/commander/config" 2>/dev/null)
  j=$(curl -s -X POST "$base/commander/jev/test" -H 'content-type: application/json' -d '{}' -o "$ART/post-jev-test.json" -w '%{http_code}' 2>/dev/null)
  record "## post-verify: health=$h state=$s config=$c jev-test=$j"
  [ "$h" = "200" ] || fail "health http=$h"
  [ "$s" = "200" ] || fail "state http=$s"
  [ "$c" = "200" ] || fail "config http=$c"
  node -e "const h=require('$ART/post-health.json');const s=require('$ART/post-state.json');const j=require('$ART/post-jev-test.json');console.log('health='+JSON.stringify(h));console.log('state='+JSON.stringify({rev:s.rev,commanderStatus:s.commanderStatus,pendingDispatch:s.pendingDispatch,workspaces:(s.workspaces||[]).length,tasks:(s.tasks||[]).length,messages:(s.messages||[]).length}));console.log('jev/test='+JSON.stringify({ok:j.ok,code:j.code??null,latencyMs:j.latencyMs??null,model:j.model??null,hasApiKey:j.hasApiKey??null}))" 2>/dev/null | tee -a "$LOG"
  # 完整检查（页面 boot graph 需 token；无 token 时该项 SKIP）
  if [ -x "$(command -v node)" ] && [ -f "$REPO/tools/dev/verify-live-m0.mjs" ]; then
    node "$REPO/tools/dev/verify-live-m0.mjs" --origin "$base" > "$ART/post-verify-live.txt" 2>&1
    local v=$?
    record "## verify-live-m0 --origin $base # exit=${v} (见 post-verify-live.txt)"
    grep -E "^(PASS|FAIL|SKIP)" "$ART/post-verify-live.txt" | tail -20 | tee -a "$LOG"
    [ "$v" -eq 0 ] || fail "verify-live-m0 exit=$v"
  fi
}

preflight
if [ "$MODE" = "plan" ]; then
  if [ "$FAILED" -ne 0 ]; then log "RESULT: FAIL（预检未过）"; exit 2; fi
  print_steps
  # 可选：在用户终端里执行 CLI 路径（agent 沙箱会失败，脚本会给明确提示）
  if [ "${CONFIRM_LIVE:-}" = "yes" ]; then
    if [ "${ALLOW_CLI_RELOAD:-}" != "yes" ]; then
      log "REFUSE: CONFIRM_LIVE=yes 还需 ALLOW_CLI_RELOAD=yes（写 ~/.dsh，仅限用户终端）"
      exit 3
    fi
    if ! ( : > "$LIVE_HOME/.m1r-write-probe" ) 2>/dev/null; then
      log "REFUSE: 当前沙箱不能写 $LIVE_HOME（agent 沙箱 workspace-write）→ 请 Lead 用 plugin_manager 执行上面步骤后跑 --post-verify"
      exit 3
    fi
    rm -f "$LIVE_HOME/.m1r-write-probe"
    log "EXECUTE: dsh plugin remove + add（用户终端）"
    dsh plugin --profile "$PROFILE" remove dsh-commander > "$ART/cli-remove.log" 2>&1; R1=$?
    dsh plugin --profile "$PROFILE" add "$PKG" > "$ART/cli-add.log" 2>&1; R2=$?
    record "\$ dsh plugin remove # exit=$R1; add # exit=$R2"
    [ "$R1" -eq 0 ] && [ "$R2" -eq 0 ] || { log "CLI 重装失败（见 cli-*.log）"; exit 4; }
    log "CLI 重装完成；如运行中 Host 未生效，请 plugin_manager set_plugin 重载或按需重启 DSH，然后 --post-verify"
  fi
  log "RESULT: PASS（预检通过；等待 Lead 执行重载，之后跑 --post-verify）"
  exit 0
fi
# post-verify 模式：先预检再复查
if [ "$FAILED" -ne 0 ]; then log "RESULT: FAIL（预检未过）"; exit 2; fi
post_verify
if [ "$FAILED" -eq 0 ]; then log "RESULT: PASS（post-verify）"; exit 0; fi
log "RESULT: FAIL（post-verify）"; exit 4
