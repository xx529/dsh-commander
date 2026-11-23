#!/bin/bash
# 一次性隔离探针环境（不写 ~/.dsh、不联网、不安装到 live profile）
#
#   PROBE_ROOT（可选，默认 <repo>/.probe）
#     ├── home/    ← DSH_HOME
#     └── agents/  ← DSH_AGENTS_HOME
#   profile = probe（web 模板：@deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app
#                    + 只读符号链接的 live dsh-capability-settings + client-ui-chat）
#
# 复现：bash tools/validation/scripts/setup-probe-env.sh
# 退出码：0 成功；非 0 失败（set -e）
#
# 说明：文档与 run-v1..v4 统一使用 **profile=probe**（web 形态，含 sessionController /
# workspaceRegistry / webServer / storageDomain）；早期版本误用 base-only 的 scout 模板，
# 会导致 run-v1 起不来（缺 sessionController）。本脚本已修正。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
PROBE="${PROBE_ROOT:-$REPO/.probe}"
DSH_HOME="$PROBE/home"
DSH_AGENTS_HOME="$PROBE/agents"
LIVE_PANEL="$HOME/.dsh/profiles/desktop/node_modules/dsh-capability-settings"
PROFILE=probe

export DSH_HOME DSH_AGENTS_HOME
mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" "$PROBE/evidence"

# 0) 定位 dsh 安装目录（用于只读符号链接 client-ui-chat；web 模板的 UI 入口需要它）
DSH_BIN="$(command -v dsh || true)"
CLI_DIR=""
if [ -n "$DSH_BIN" ] && [ -f "$DSH_BIN" ]; then
  # dsh 垫片形如：exec "$HOME/.nvm/.../node" "$HOME/.nvm/.../@deepseek-ai/dsh/lib/bin.js" "$@"
  # 注意垫片里是字面 "$HOME"，需自行展开。
  CLI_BINJS="$(sed -n 's#.*"\([^"]*lib/node_modules/@deepseek-ai/dsh/lib/bin.js\)".*#\1#p' "$DSH_BIN" | head -1)"
  CLI_BINJS="${CLI_BINJS//\$HOME/$HOME}"
  if [ -n "$CLI_BINJS" ] && [ -f "$CLI_BINJS" ]; then
    CLI_DIR="$(dirname "$(dirname "$CLI_BINJS")")"
  fi
fi
if [ -z "$CLI_DIR" ] || [ ! -d "$CLI_DIR" ]; then
  # 回退：扫描 nvm 各 node 版本下的全局安装（取最新）
  CLI_DIR="$(ls -d "$HOME"/.nvm/versions/node/*/lib/node_modules/@deepseek-ai/dsh 2>/dev/null | tail -1)"
fi
CLI_OK=0
[ -d "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" ] && CLI_OK=1

# 1a) 兼容保留：scout = base 模板（早期 V1 侦察用的最小 Host；run 脚本已改用 probe，但保留以便旧记录/脚本复跑）
if [ ! -f "$DSH_HOME/profiles/scout/package.json" ]; then
  dsh plugin --profile scout version-exemptions > /dev/null 2>&1 || true
fi

# 1b) 初始化 probe profile（web 模板 = @deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app；
#     是 V1–V4 文档与 run-v1..v4 统一使用的形态：含 sessionController/workspaceRegistry/
#     webServer/storageDomain）。只写 $DSH_HOME。
if [ ! -f "$DSH_HOME/profiles/$PROFILE/package.json" ]; then
  dsh --profile "$PROFILE" --from-default-profile web --dump-default-config > /dev/null
fi

# 2) 只读复用 live desktop profile 的 dsh-capability-settings（零复制、零网络、不写 live）
mkdir -p "$DSH_HOME/profiles/$PROFILE/node_modules"
ln -sfn "$LIVE_PANEL" "$DSH_HOME/profiles/$PROFILE/node_modules/dsh-capability-settings"

# 2b) web 模板需要 client-ui-chat（不是 CLI 的直接依赖；只读符号链接进探针 profile）
if [ "$CLI_OK" = "1" ]; then
  mkdir -p "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai"
  ln -sfn "$CLI_DIR/node_modules/@deepseek-ai/dsh-client-ui-chat" \
          "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai/dsh-client-ui-chat"
fi

# 3) 把能力面板加入 profile bundles（幂等）；并保证存在 base+web-app（web 模板自带）
node - "$DSH_HOME/profiles/$PROFILE/package.json" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
const bundles = (pkg.dsh.profile.bundles ??= ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
if (!bundles.includes('@deepseek-ai/dsh-base')) bundles.unshift('@deepseek-ai/dsh-base')
if (!bundles.includes('@deepseek-ai/dsh-web-app')) bundles.push('@deepseek-ai/dsh-web-app')
if (!bundles.includes('dsh-capability-settings')) bundles.push('dsh-capability-settings')
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
NODE

# 4) fixture skill：给 jev.rank 提供一个**非宿主注入**、可开关的 skill 能力
#    （隔离环境里其余能力都是 host-injected，不可开关，无法验证 apply 的会话开关语义）
mkdir -p "$DSH_AGENTS_HOME/skills/probe-e2e-testing"
cat > "$DSH_AGENTS_HOME/skills/probe-e2e-testing/SKILL.md" <<'SKILL'
---
name: probe-e2e-testing
description: "为前端项目编写单元测试与浏览器自动化端到端测试（Playwright），并修复测试失败。"
---
# probe-e2e-testing（隔离探针 fixture）

这是验证用的一次性 fixture 技能，仅存在于探针 `DSH_AGENTS_HOME/skills/`，
用于给能力面板 `jev.rank` 提供一个**可开关**（非宿主注入）的 skill 能力。

它没有任何真实行为；内容仅供 V1 验证 `apply` 的会话开关语义。
SKILL

# 5) 运行脚本用到的临时工作目录
mkdir -p "$PROBE/ws-cold" "$PROBE/ws-v2" "$PROBE/ws-v3"

echo "probe env ready:"
echo "  PROBE_ROOT=$PROBE"
echo "  DSH_HOME=$DSH_HOME"
echo "  DSH_AGENTS_HOME=$DSH_AGENTS_HOME"
echo "  profiles: scout(base) + $PROFILE(web)  → $DSH_HOME/profiles/$PROFILE ($(node -e "console.log((require('$DSH_HOME/profiles/$PROFILE/package.json').dsh?.profile?.bundles ?? []).join(' + '))" 2>/dev/null || echo '?'))"
echo "  panel -> $(readlink "$DSH_HOME/profiles/$PROFILE/node_modules/dsh-capability-settings" 2>/dev/null || echo missing)"
if [ "$CLI_OK" = "1" ]; then echo "  client-ui-chat -> $(readlink "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai/dsh-client-ui-chat")"; else echo "  client-ui-chat: CLI 安装未找到（web UI 入口会告警，Host 侧探针不受影响）"; fi
node -e "console.log('  panel version =', require('$DSH_HOME/profiles/$PROFILE/node_modules/dsh-capability-settings/package.json').version)" 2>/dev/null || true
