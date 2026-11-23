#!/bin/bash
# M0-1 live 安装准备/执行脚本（desktop profile）
#
# 安全模型：
#   - 默认 = `--check`：**只读**预检（构建产物/verify-bundle/desktop profile 现状/隔离基线），
#     并打印「可执行安装命令 + 回滚命令」；不写任何 profile。
#   - `--execute`：真正执行 `dsh plugin --profile desktop add <绝对包路径>`（需要
#     `CONFIRM_LIVE_WRITE=yes` 且显式确认；**只能由 Lead/用户在自己的终端执行**——
#     devops agent 的沙箱禁止写 ~/.dsh）。执行前后各采一次 profile 快照。
#   - **本脚本绝不重启 DSH**；重启需用户手动执行（会中断当前会话/agent 进程）。
#
# 用法：
#   bash tools/dev/install-live-m0.sh                 # 预检 + 打印命令（默认，只读）
#   CONFIRM_LIVE_WRITE=yes bash tools/dev/install-live-m0.sh --execute   # 由 Lead/用户执行安装
#   OUTDIR=/tmp/m0-live bash tools/dev/install-live-m0.sh                # 证据输出目录可覆盖
#   LIVE_FULL_BASELINE=1 ... --check                                     # 额外做全树 hash（≤180s，默认跳过；运行中 Desktop 扫树很慢）
#
# 退出码：0 = 预检通过（或执行成功）；非 0 = 预检/执行失败。
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PKG_DIR="$REPO/packages/dsh-commander"
ART="${OUTDIR:-$REPO/docs/validation/m0-live-artifacts}"
LIVE_HOME="${DSH_HOME_OVERRIDE:-$HOME/.dsh}"
DESKTOP_PROFILE="$LIVE_HOME/profiles/desktop"
PROFILE=desktop
EXECUTE=0
for arg in "$@"; do
  case "$arg" in
    --execute) EXECUTE=1 ;;
    --check) EXECUTE=0 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done
mkdir -p "$ART"
LOG="$ART/preflight.log"
: > "$LOG"
FAILED=0
log() { echo "[install-live-m0] $*" | tee -a "$LOG"; }
record() { echo "$*" >> "$LOG"; }
fail() { log "FAIL: $*"; FAILED=1; }

log "repo=$REPO"
log "package=$PKG_DIR"
log "desktop_profile=$DESKTOP_PROFILE"
log "mode=$([ "$EXECUTE" -eq 1 ] && echo execute || echo check)"

# ---- 1) 构建产物存在 + client bundle 契约 ----
HOST_ENTRY="$PKG_DIR/lib/host/index.js"
CLIENT_BUNDLE="$PKG_DIR/lib/client.js"
[ -f "$HOST_ENTRY" ] || fail "缺少 Host 产物 $HOST_ENTRY（先跑 pnpm --filter dsh-commander build）"
[ -f "$CLIENT_BUNDLE" ] || fail "缺少 Client 产物 $CLIENT_BUNDLE（先跑 pnpm --filter dsh-commander build）"
if [ -f "$CLIENT_BUNDLE" ]; then
  node "$REPO/tools/dev/verify-bundle.mjs" "$CLIENT_BUNDLE" dsh-commander > "$ART/verify-bundle.json" 2>&1
  VB_EXIT=$?
  record "\$ node tools/dev/verify-bundle.mjs $CLIENT_BUNDLE dsh-commander   # exit=$VB_EXIT"
  [ "$VB_EXIT" -eq 0 ] || fail "client bundle 契约校验失败（见 $ART/verify-bundle.json）"
fi
log "build artifacts: host=$( [ -f "$HOST_ENTRY" ] && echo ok || echo missing ) client=$( [ -f "$CLIENT_BUNDLE" ] && echo "$(wc -c < "$CLIENT_BUNDLE" | tr -d ' ')B" || echo missing )"

# ---- 2) desktop profile 现状快照（只读）----
if [ ! -f "$DESKTOP_PROFILE/package.json" ]; then
  fail "desktop profile 不存在：$DESKTOP_PROFILE"
else
  cp "$DESKTOP_PROFILE/package.json" "$ART/profile-before-package.json"
  node - "$ART/profile-before-package.json" "$ART/profile-before-summary.json" <<'NODE' 2> "$ART/profile-before-summary.err"
const fs = require('node:fs')
const pkg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const deps = pkg.dependencies ?? {}
const bundles = pkg.dsh?.profile?.bundles ?? []
fs.writeFileSync(process.argv[3], JSON.stringify({
  installed: Object.hasOwn(deps, 'dsh-commander'),
  dependency: deps['dsh-commander'] ?? null,
  bundleListed: bundles.includes('dsh-commander'),
  bundleCount: bundles.length,
  bundles,
}, null, 2) + '\n')
NODE
  ALREADY=$(node -e "const j=require('$ART/profile-before-summary.json');console.log(j.installed?'yes':'no')" 2>/dev/null || echo unknown)
  BUNDLE_LISTED=$(node -e "const j=require('$ART/profile-before-summary.json');console.log(j.bundleListed?'yes':'no')" 2>/dev/null || echo unknown)
  record "## desktop profile before: installed=$ALREADY bundleListed=$BUNDLE_LISTED bundles=$(node -e "console.log(require('$ART/profile-before-summary.json').bundleCount)" 2>/dev/null)"
  log "desktop profile before: dsh-commander installed=$ALREADY bundleListed=$BUNDLE_LISTED"
fi

# ---- 2b) lib 文件一致性（防“安装副本陈旧”：M1 新增源文件不会被 hardlink 自动带进已装包）----
LIVE_PKG="$DESKTOP_PROFILE/node_modules/dsh-commander"
REPO_JS=$(find "$PKG_DIR/lib" -name '*.js' 2>/dev/null | wc -l | tr -d ' ')
record "## repo lib js files=$REPO_JS"
if [ -d "$LIVE_PKG" ]; then
  LIVE_JS=$(find "$LIVE_PKG/lib" -name '*.js' 2>/dev/null | wc -l | tr -d ' ')
  MISSING=$(comm -23 <( cd "$PKG_DIR/lib" 2>/dev/null && find . -name '*.js' | sort ) <( cd "$LIVE_PKG/lib" 2>/dev/null && find . -name '*.js' | sort ) 2>/dev/null | head -50)
  MISSING_N=$(printf '%s\n' "$MISSING" | grep -c . 2>/dev/null || true)
  record "## live lib js files=$LIVE_JS missing=$MISSING_N"
  if [ "$MISSING_N" -gt 0 ]; then
    fail "live 安装副本缺少 $MISSING_N 个新 lib 文件（如 $(printf '%s' "$MISSING" | head -3 | tr '\n' ' ')）→ 必须 remove_bundle+install_bundle（或 dsh plugin remove/add）后重启；单纯重启/刷新不会同步新文件"
  else
    log "live lib 文件与 repo 一致（$LIVE_JS 个 .js）"
  fi
else
  log "live profile 尚未安装 dsh-commander（lib 一致性检查跳过）"
fi

# 快速 live 基线（不扫全树；运行中的 Desktop 下全树 hash 可能 >5 分钟，见 --full-baseline）
fast_baseline() {
  local out="$1"
  {
    echo "# live baseline(fast) $(date '+%Y-%m-%dT%H:%M:%S%z')"
    echo "## desktop package.json sha256"
    shasum -a 256 "$DESKTOP_PROFILE/package.json" 2>/dev/null || echo missing
    echo "## desktop pnpm-lock sha256"
    shasum -a 256 "$DESKTOP_PROFILE/pnpm-lock.yaml" 2>/dev/null || echo missing
    echo "## dsh home .env stat (size|mtime)"
    stat -f '%N|%z|%m' "$LIVE_HOME/.env" 2>/dev/null || echo missing
    echo "## desktop node_modules top-level count"
    ls "$DESKTOP_PROFILE/node_modules" 2>/dev/null | wc -l
    echo "## desktop bundles list"
    node -e "const p=require('$DESKTOP_PROFILE/package.json');console.log(JSON.stringify(p.dsh?.profile?.bundles??[]))" 2>/dev/null || echo unreadable
  } > "$out" 2>&1
}
# 全树 hash（可选，--full-baseline；带 180s 超时，避免 Desktop 运行时扫树卡死）
full_baseline() {
  local out="$1"
  perl -e 'alarm 180; exec @ARGV' bash "$REPO/tools/validation/scripts/live-state.sh" "$out" >/dev/null 2>&1
  local code=$?
  [ "$code" -eq 0 ] && echo "## full baseline ok" >> "$out" || echo "## full baseline TIMEOUT/FAILED (exit=$code)" >> "$out"
}
fast_baseline "$ART/live-baseline-before-fast.txt"
log "fast baseline -> $ART/live-baseline-before-fast.txt"
if [ "${LIVE_FULL_BASELINE:-0}" = "1" ]; then full_baseline "$ART/live-baseline-before.txt"; log "full baseline -> $ART/live-baseline-before.txt"; fi

# ---- 3) 打印推荐命令（预检模式的主输出）----
ABS_PKG="$PKG_DIR"
INSTALL_CMD="dsh plugin --profile $PROFILE add $ABS_PKG"
DUMP_CMD="dsh --profile $PROFILE --dump-config | grep -n -A3 \"name: 'dsh-commander'\""
ROLLBACK_CMD="dsh plugin --profile $PROFILE remove dsh-commander"
RESTART_NOTE="退出并重新打开 DeepSeek Harness（重启会中断当前会话/agent 进程）"
VERIFY_CMD="node $REPO/tools/dev/verify-live-m0.mjs --url '<浏览器地址栏完整 URL，含 ?token=…>'"
{
  echo ""
  echo "================ M0-1 live 安装命令（由 Lead/用户在自己的终端执行）================"
  echo "# 0) 构建（devops 侧已完成；若代码有更新先重跑）"
  echo "cd $REPO && pnpm --filter dsh-commander build"
  echo ""
  echo "# 1) 预检（只读；本脚本可重复跑）"
  echo "bash $REPO/tools/dev/install-live-m0.sh"
  echo ""
  echo "# 2) 安装到 desktop profile（绝对路径；需要写 ~/.dsh，agent 沙箱不允许 → 由你在终端执行）"
  echo "$INSTALL_CMD"
  echo ""
  echo "# 3) 校验 profile 合成（应出现 commander 行；退出码 0）"
  echo "$DUMP_CMD"
  echo ""
  echo "# 4) 重启 DSH：$RESTART_NOTE"
  echo ""
  echo "# 5) 安装后健康检查（用浏览器地址栏 URL 的完整 origin+token）"
  echo "$VERIFY_CMD"
  echo ""
  echo "# 回滚（任一步失败或验收不过时）"
  echo "$ROLLBACK_CMD"
  echo "# 回滚后同样需要重启 DSH；再跑 verify-live-m0.mjs 应提示 /commander/health 不可达"
  echo "==============================================================================="
} | tee -a "$LOG"

# ---- 4) --execute：真正安装（仅 Lead/用户）----
if [ "$EXECUTE" -eq 1 ]; then
  if [ "${CONFIRM_LIVE_WRITE:-}" != "yes" ]; then
    log "REFUSE: --execute requires CONFIRM_LIVE_WRITE=yes（写 live profile 需显式确认）"
    exit 3
  fi
  case "$LIVE_HOME" in
    "$HOME/.dsh") : ;;
    *) log "REFUSE: live home 必须是 $HOME/.dsh（当前 $LIVE_HOME）"; exit 3 ;;
  esac
  log "EXECUTE: $INSTALL_CMD"
  # 不修改调用者环境，只给该命令显式 DSH_HOME
  DSH_HOME="$LIVE_HOME" /bin/bash -c "$INSTALL_CMD" > "$ART/install.log" 2>&1
  INSTALL_EXIT=$?
  record "\$ $INSTALL_CMD   # exit=$INSTALL_EXIT"
  log "install exit=$INSTALL_EXIT (log: $ART/install.log)"
  [ "$INSTALL_EXIT" -eq 0 ] || { log "安装失败；见 $ART/install.log"; exit 4; }
  cp "$DESKTOP_PROFILE/package.json" "$ART/profile-after-package.json"
  node - "$ART/profile-before-summary.json" "$ART/profile-after-package.json" "$ART/bundles-diff.json" <<'NODE' >> "$LOG" 2>&1
const fs = require('node:fs')
const before = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const afterPkg = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const afterBundles = afterPkg.dsh?.profile?.bundles ?? []
const added = afterBundles.filter((b) => !before.bundles.includes(b))
const removed = before.bundles.filter((b) => !afterBundles.includes(b))
const out = { installed: Object.hasOwn(afterPkg.dependencies ?? {}, 'dsh-commander'), dependency: afterPkg.dependencies?.['dsh-commander'] ?? null, added, removed, bundleCount: afterBundles.length }
fs.writeFileSync(process.argv[4], JSON.stringify(out, null, 2) + '\n')
console.log('## bundles diff after install:', JSON.stringify(out))
NODE
  DSH_HOME="$LIVE_HOME" /bin/bash -c "dsh --profile $PROFILE --dump-config" > "$ART/dump-config-after.yml" 2> "$ART/dump-config-after.err"
  DUMP_EXIT=$?
  grep -n -A3 "name: 'dsh-commander'" "$ART/dump-config-after.yml" > "$ART/dump-config-commander.txt" 2>&1 || true
  record "\$ dsh --profile $PROFILE --dump-config   # exit=$DUMP_EXIT"
  [ "$DUMP_EXIT" -eq 0 ] || fail "安装后 --dump-config 失败（见 $ART/dump-config-after.err）"
  [ -s "$ART/dump-config-commander.txt" ] || fail "安装后 --dump-config 未出现 dsh-commander 行"
  fast_baseline "$ART/live-baseline-after-fast.txt"
  if [ "${LIVE_FULL_BASELINE:-0}" = "1" ]; then full_baseline "$ART/live-baseline-after.txt"; fi
  echo "## diff fast baseline (before vs after install)" >> "$LOG"
  diff "$ART/live-baseline-before-fast.txt" "$ART/live-baseline-after-fast.txt" > "$ART/live-baseline-fast-diff.txt" 2>&1 || true
  if grep -q '"dsh-commander"' "$ART/live-baseline-after-fast.txt" 2>/dev/null || node -e "const fs=require('fs');const b=fs.readFileSync('$ART/live-baseline-after-fast.txt','utf8');process.exit(b.includes('dsh-commander')?0:1)" 2>/dev/null; then
    log "after-install baseline contains dsh-commander（预期）"
  fi
  log "安装完成。下一步：重启 DSH（$RESTART_NOTE），然后运行 verify-live-m0.mjs"
fi

if [ "$FAILED" -eq 0 ]; then log "RESULT: PASS（$([ "$EXECUTE" -eq 1 ] && echo 已执行安装 || echo 预检通过，未写 live profile)）"; exit 0; fi
log "RESULT: FAIL"; exit 1
